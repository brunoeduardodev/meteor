var _ = require('underscore');
var files = require('../fs/files');
var parseStack = require('./parse-stack');
var fiberHelpers = require('./fiber-helpers.js');
var Progress = require('../console/progress').Progress;

var debugBuild = !!process.env.METEOR_DEBUG_BUILD;

// A job is something like "building package foo". It contains the set
// of messages generated by the job. A given build run could contain
// several jobs. Each job has an (absolute) path associated with
// it. Filenames in messages within a job are to be interpreted
// relative to that path.
//
// Jobs are used both for error handling (via buildmessage.capture) and to set
// the progress bar title (via progress.ts).
//
// Job titles should begin with a lower-case letter (unless they begin with a
// proper noun), so that they look correct in error messages which say "While
// jobbing the job".  The first letter will be capitalized automatically for the
// progress bar.
var Job = function (options) {
  var self = this;
  self.messages = [];

  // Should be something like "building package 'foo'"
  // Should look good in "While $title:\n[messages]"
  self.title = options.title;
  self.rootPath = options.rootPath;

  // Array of Job (jobs created inside this job)
  self.children = [];
};

Object.assign(Job.prototype, {
  // options may include type ("error"), message, func, file, line,
  // column, stack (in the format returned by parseStack.parse())
  addMessage: function (options) {
    var self = this;
    self.messages.push(options);
  },

  hasMessages: function () {
    var self = this;
    return self.messages.length > 0;
  },

  hasMessageWithTag: function (tagName) {
    var self = this;
    return _.any(self.messages, function (message) {
      return message.tags && _.has(message.tags, tagName);
    });
  },

  // Returns a multi-line string suitable for displaying to the user
  formatMessages: function (indent) {
    var self = this;
    var out = "";
    var already = {};
    indent = new Array((indent || 0) + 1).join(' ');

    _.each(self.messages, function (message) {
      var stack = message.stack || [];

      var line = indent;
      if (message.file) {
        line+= message.file;
        if (message.line) {
          line += ":" + message.line;
          if (message.column) {
            // XXX maybe exclude unless specifically requested (eg,
            // for an automated tool that's parsing our output?)
            line += ":" + message.column;
          }
        }
        line += ": ";
      } else {
        // not sure how to display messages without a file name.. try this?
        line += "error: ";
      }
      // XXX line wrapping would be nice..
      line += message.message;
      if (message.func && stack.length <= 1) {
        line += " (at " + message.func + ")";
      }
      line += "\n";

      if (stack.length > 1) {
        _.each(stack, function (frame) {
          // If a nontrivial stack trace (more than just the file and line
          // we already complained about), print it.
          var where = "";
          if (frame.file) {
            where += frame.file;
            if (frame.line) {
              where += ":" + frame.line;
              if (frame.column) {
                where += ":" + frame.column;
              }
            }
          }

          if (! frame.func && ! where) {
            // that's a pretty lame stack frame
            return;
          }

          line += "  at ";
          if (frame.func) {
            line += frame.func + " (" + where + ")\n";
          } else {
            line += where + "\n";
          }
        });
        line += "\n";
      }

      // Deduplicate messages (only when exact duplicates, including stack)
      if (! (line in already)) {
        out += line;
        already[line] = true;
      }
    });

    return out;
  }

});

// A MessageSet contains a set of jobs, which in turn each contain a
// set of messages.
var MessageSet = function (messageSet) {
  var self = this;
  self.jobs = [];

  if (messageSet) {
    self.jobs = _.clone(messageSet.jobs);
  }
};

Object.assign(MessageSet.prototype, {
  formatMessages: function () {
    var self = this;

    var jobsWithMessages = _.filter(self.jobs, function (job) {
      return job.hasMessages();
    });

    return _.map(jobsWithMessages, function (job) {
      var out = '';
      out += "While " + job.title + ":\n";
      out += job.formatMessages(0);
      return out;
    }).join('\n'); // blank line between jobs
  },

  hasMessages: function () {
    var self = this;
    return _.any(self.jobs, function (job) {
      return job.hasMessages();
    });
  },

  hasMessageWithTag: function (tagName) {
    var self = this;
    return _.any(self.jobs, function (job) {
      return job.hasMessageWithTag(tagName);
    });
  },

  // Copy all of the messages in another MessageSet into this
  // MessageSet. If the other MessageSet is subsequently mutated,
  // results are undefined.
  //
  // XXX rather than this, the user should be able to create a
  // MessageSet and pass it into capture(), and functions such as
  // bundle() should take and mutate, rather than return, a
  // MessageSet.
  merge: function (messageSet) {
    var self = this;
    _.each(messageSet.jobs, function (j) {
      self.jobs.push(j);
    });
  }
});

var spaces = function (n) {
  return _.times(n, function() { return ' ' }).join('');
};

// XXX: This is now a little bit silly... ideas:
// Can we just have one hierarchical state?
// Can we combined job & messageSet
// Can we infer nesting level?
var currentMessageSet = new fiberHelpers.EnvironmentVariable;
var currentJob = new fiberHelpers.EnvironmentVariable;
var currentNestingLevel = new fiberHelpers.EnvironmentVariable(0);
var currentProgress = new fiberHelpers.EnvironmentVariable;

var rootProgress = new Progress();

var getRootProgress = function () {
  return rootProgress;
};

var reportProgress = function (state) {
  var progress = currentProgress.get();
  if (progress) {
    progress.reportProgress(state);
  }
};

var reportProgressDone = function () {
  var progress = currentProgress.get();
  if (progress) {
    progress.reportProgressDone();
  }
};

var getCurrentProgressTracker = function () {
  var progress = currentProgress.get();
  return progress ? progress : rootProgress;
};

var addChildTracker = function (title) {
  var options = {};
  if (title !== undefined) {
    options.title = title;
  }
  return getCurrentProgressTracker().addChildTask(options);
};

// Create a new MessageSet, run `f` with that as the current
// MessageSet for the purpose of accumulating and recovering from
// errors (see error()), and then discard the return value of `f` and
// return the MessageSet.
//
// Note that you must also create a job (with enterJob) to actually
// begin capturing errors. Alternately you may pass `options`
// (otherwise optional) and a job will be created for you based on
// `options`.
function capture(options, f) {
  var messageSet = new MessageSet;
  var parentMessageSet = currentMessageSet.get();

  var title;
  if (typeof options === "object" && options.title) {
    title = options.title;
  }
  var progress = addChildTracker(title);

  const resetFns = [
    currentProgress.set(progress),
    currentMessageSet.set(messageSet),
  ];

  let job = null;
  if (typeof options === "object") {
    job = new Job(options);
    messageSet.jobs.push(job);
  } else {
    f = options; // options not actually provided
  }

  resetFns.push(currentJob.set(job));

  const nestingLevel = currentNestingLevel.get();
  resetFns.push(currentNestingLevel.set(nestingLevel + 1));

  var start;
  if (debugBuild) {
    start = Date.now();
    console.log(
      spaces(nestingLevel * 2),
      "START CAPTURE",
      nestingLevel,
      options.title,
      "took " + (end - start),
    );
  }

  try {
    f();
  } finally {
    progress.reportProgressDone();

    resetFns.forEach(fn => fn());

    if (debugBuild) {
      var end = Date.now();
      console.log(
        spaces(nestingLevel * 2),
        "END CAPTURE",
        nestingLevel,
        options.title,
        "took " + (end - start),
      );
    }
  }

  return messageSet;
}

// Called from inside capture(), creates a new Job inside the current
// MessageSet and run `f` inside of it, so that any messages emitted
// by `f` are logged in the Job. Returns the return value of `f`. May
// be called recursively.
//
// Called not from inside capture(), does nothing (except call f).
//
// options:
// - title: a title for the job (required)
// - rootPath: the absolute path relative to which paths in messages
//   in this job should be interpreted (omit if there is no way to map
//   files that this job talks about back to files on disk)
function enterJob(options, f) {
  if (typeof options === "function") {
    f = options;
    options = {};
  }

  if (typeof options === "string") {
    options = {title: options};
  }

  var progress;
  {
    var progressOptions = {};
    // XXX: Just pass all the options?
    if (typeof options === "object") {
      if (options.title) {
        progressOptions.title = options.title;
      }
      if (options.forkJoin) {
        progressOptions.forkJoin = options.forkJoin;
      }
    }
    progress = getCurrentProgressTracker().addChildTask(progressOptions);
  }

  const resetFns = [
    currentProgress.set(progress),
  ];

  if (!currentMessageSet.get()) {
    var nestingLevel = currentNestingLevel.get();
    var start;
    if (debugBuild) {
      start = Date.now();
      console.log(spaces(nestingLevel * 2), "START", nestingLevel, options.title);
    }

    resetFns.push(currentNestingLevel.set(nestingLevel + 1));

    try {
      return f();
    } finally {
      progress.reportProgressDone();

      while (resetFns.length) {
        resetFns.pop()();
      }

      if (debugBuild) {
        var end = Date.now();
        console.log(spaces(nestingLevel * 2), "DONE", nestingLevel, options.title, "took " + (end - start));
      }
    }
  }

  var job = new Job(options);
  var originalJob = currentJob.get();
  originalJob && originalJob.children.push(job);
  currentMessageSet.get().jobs.push(job);

  resetFns.push(currentJob.set(job));

  var nestingLevel = currentNestingLevel.get();
  resetFns.push(currentNestingLevel.set(nestingLevel + 1));

  var start;
  if (debugBuild) {
    start = Date.now();
    console.log(spaces(nestingLevel * 2), "START", nestingLevel, options.title);
  }

  try {
    return f();
  } finally {
    progress.reportProgressDone();

    while (resetFns.length) {
      resetFns.pop()();
    }

    if (debugBuild) {
      var end = Date.now();
      console.log(
        spaces(nestingLevel * 2),
        "DONE",
        nestingLevel,
        options.title,
        "took " + (end - start),
      );
    }
  }
}

// If not inside a job, return false. Otherwise, return true if any
// messages (presumably errors) have been recorded for this job
// (including subjobs created inside this job), else false.
var jobHasMessages = function () {
  var search = function (job) {
    if (job.hasMessages()) {
      return true;
    }
    return !! _.find(job.children, search);
  };

  return currentJob.get() ? search(currentJob.get()) : false;
};

// Given a function f, return a "marked" version of f. The mark
// indicates that stack traces should stop just above f. So if you
// mark a user-supplied callback function before calling it, you'll be
// able to show the user just the "user portion" of the stack trace
// (the part inside their own code, and not all of the innards of the
// code that called it).
var markBoundary = function (f, context) {
  return parseStack.markBottom(f, context);
};

// Record a build error. If inside a job, add the error to the current
// job and return (caller should do its best to recover and
// continue). Otherwise, throws an exception based on the error.
//
// options may include
// - file: the file containing the error, relative to the root of the build
//   (this must be agreed upon out of band)
// - line: the (1-indexed) line in the file that contains the error
// - column: the (1-indexed) column in that line where the error begins
// - func: the function containing the code that triggered the error
// - useMyCaller: true to capture information the caller (function
//   name, file, and line). It captures not the information of the
//   caller of error(), but that caller's caller. It saves them in
//   'file', 'line', and 'column' (overwriting any values passed in
//   for those). It also captures the user portion of the stack,
//   starting at and including the caller's caller.
//   If this is a number instead of 'true', skips that many stack frames.
// - downcase: if true, the first character of `message` will be
//   converted to lower case.
// - secondary: ignore this error if there are already other
//   errors in this job (the implication is that it's probably
//   downstream of the other error, ie, a consequence of our attempt
//   to continue past other errors)
// - tags: object with other error-specific data; there is a method
//   on MessageSet which can search for errors with a specific named
//   tag.
var error = function (message, options) {
  options = options || {};

  if (options.downcase) {
    message = message.slice(0,1).toLowerCase() + message.slice(1);
  }

  if (! currentJob.get()) {
    throw new Error("Error: " + message);
  }

  if (options.secondary && jobHasMessages()) {
    // skip it
    return;
  }

  var info = Object.assign({
    message: message
  }, options);

  if ('useMyCaller' in info) {
    if (info.useMyCaller) {
      const {
        insideFiber,
        outsideFiber
      } = parseStack.parse(new Error());

      // Concatenate and get rid of lines about Future and buildmessage
      info.stack = outsideFiber.concat(insideFiber || []).slice(2);
      if (typeof info.useMyCaller === 'number') {
        info.stack = info.stack.slice(info.useMyCaller);
      }
      var caller = info.stack[0];
      info.func = caller.func;
      info.file = caller.file;
      info.line = caller.line;
      info.column = caller.column;
    }
    delete info.useMyCaller;
  }

  currentJob.get().addMessage(info);
};

// Record an exception. The message as well as any file and line
// information be read directly out of the exception. If not in a job,
// throws the exception instead. Also capture the user portion of the stack.
//
// There is special handling for files.FancySyntaxError exceptions. We
// will grab the file and location information where the syntax error
// actually occurred, rather than the place where the exception was
// thrown.
var exception = function (error) {
  if (! currentJob.get()) {
    // XXX this may be the wrong place to do this, but it makes syntax errors in
    // files loaded via isopack.load have context.
    if (error instanceof files.FancySyntaxError) {
      error = new Error("Syntax error: " + error.message + " at " +
        error.file + ":" + error.line + ":" + error.column);
    }
    throw error;
  }

  var message = error.message;

  if (error instanceof files.FancySyntaxError) {
    // No stack, because FancySyntaxError isn't a real Error and has no stack
    // property!
    currentJob.get().addMessage({
      message: message,
      file: error.file,
      line: error.line,
      column: error.column
    });
  } else {
    var parsed = parseStack.parse(error);

    // If there is a part inside the fiber, that's the one we want. Otherwise,
    // use the one outside.
    var stack = parsed.insideFiber || parsed.outsideFiber;
    if (stack && stack.length > 0) {
      var locus = stack[0];
      currentJob.get().addMessage({
        message: message,
        stack: stack,
        func: locus.func,
        file: locus.file,
        line: locus.line,
        column: locus.column
      });
    } else {
      currentJob.get().addMessage({
        message: message
      });
    }
  }
};

var assertInJob = function () {
  if (! currentJob.get()) {
    throw new Error("Expected to be in a buildmessage job");
  }
};

var assertInCapture = function () {
  if (! currentMessageSet.get()) {
    throw new Error("Expected to be in a buildmessage capture");
  }
};

var mergeMessagesIntoCurrentJob = function (innerMessages) {
  var outerMessages = currentMessageSet.get();
  if (! outerMessages) {
    throw new Error("Expected to be in a buildmessage capture");
  }
  var outerJob = currentJob.get();
  if (! outerJob) {
    throw new Error("Expected to be in a buildmessage job");
  }
  _.each(innerMessages.jobs, function (j) {
    outerJob.children.push(j);
  });
  outerMessages.merge(innerMessages);
};

// Like _.each, but runs each operation in a separate job
var forkJoin = function (options, iterable, fn) {
  if (!_.isFunction(fn)) {
    fn = iterable;
    iterable = options;
    options = {};
  }

  options.forkJoin = true;

  function enterJobAsync(options) {
    return new Promise((resolve, reject) => {
      enterJob(options, err => {
        err ? reject(err) : resolve();
      });
    });
  }

  const parallel = (options.parallel !== undefined) ? options.parallel : true;

  return enterJobAsync(options).then(() => {
    const errors = [];
    let results = _.map(iterable, (...args) => {
      const promise = enterJobAsync({
        title: (options.title || "") + " child"
      }).then(() => fn(...args))
        // Collect any errors thrown (and later re-throw the first one),
        // but don't stop processing remaining jobs.
        .catch(error => (errors.push(error), null));

      if (parallel) {
        // If the jobs are intended to run in parallel, return each
        // promise without awaiting it, so that Promise.all can wait for
        // them all to be fulfilled.
        return promise;
      }

      // By awaiting the promise during each iteration, we effectively
      // serialize the execution of the jobs.
      return promise.await();
    });

    if (parallel) {
      // If the jobs ran in parallel, then results is an array of Promise
      // objects that still need to be resolved.
      results = Promise.all(results).await();
    }

    if (errors.length > 0) {
      // If any errors were thrown, re-throw the first one. Note that this
      // allows jobs to complete successfully (and have whatever
      // side-effects they should have) after the first error is thrown,
      // though the final results will not be returned below.
      throw errors[0];
    }

    return results;
  }).await();
};


var buildmessage = exports;
Object.assign(exports, {
  capture: capture,
  enterJob: enterJob,
  markBoundary: markBoundary,
  error: error,
  exception: exception,
  jobHasMessages: jobHasMessages,
  assertInJob: assertInJob,
  assertInCapture: assertInCapture,
  mergeMessagesIntoCurrentJob: mergeMessagesIntoCurrentJob,
  forkJoin: forkJoin,
  getRootProgress: getRootProgress,
  reportProgress: reportProgress,
  reportProgressDone: reportProgressDone,
  getCurrentProgressTracker: getCurrentProgressTracker,
  addChildTracker: addChildTracker,
  _MessageSet: MessageSet
});
