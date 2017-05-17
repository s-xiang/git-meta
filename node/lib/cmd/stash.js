/*
 * Copyright (c) 2017, Two Sigma Open Source
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * * Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * * Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * * Neither the name of git-meta nor the names of its
 *   contributors may be used to endorse or promote products derived from
 *   this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */
"use strict";

const co = require("co");

/**
 * This module contains the command entry point for stash.
 */

/**
 * help text for the `stash` command
 * @property {String}
 */
exports.helpText = `Stash changes to the index and working directory`;

/**
 * description of the `stash` command
 * @property {String}
 */
exports.description =`
Provide commands for saving and restoring the state of the monorepo.`;

exports.configureParser = function (parser) {

    parser.addArgument(["-p", "--pop"], {
        help: "restore the last stash",
        action: "storeConst",
        constant: true,
    });
    parser.addArgument(["--meta"], {
        help: `
Include changes to the meta-repo; disabled by default to prevent mistakes.`,
        action: "storeConst",
        constant: true,
    });

    const subParsers = parser.addSubparsers({
        dest: "command",
    });
    subParsers.addParser("save", {
        help: "save changes in the workdir and index",
    });
    subParsers.addParser("pop", {
        help: "restore saved changes",
    });
};

const doPop = co.wrap(function *() {
    const StashUtil = require("../../lib/util/stash_util");
    yield StashUtil.pop();
});

const doSave = co.wrap(function *(args) {
    const GitUtil   = require("../../lib/util/git_util");
    const StashUtil = require("../../lib/util/stash_util");
    const repo = yield GitUtil.getCurrentRepo();
    yield StashUtil.save(repo, args.meta);
});

/**
 * Execute the `stash` command according to the specified `args`.
 *
 * @param {Object}  args
 */
exports.executeableSubcommand = function (args) {
    console.log(args);
    switch(args.command) {
        case "pop" : return doPop(args);
        case "save": return doSave(args);
    }
};
