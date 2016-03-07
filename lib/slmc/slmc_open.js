/*
 * Copyright (c) 2016, Two Sigma Open Source
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
 * * Neither the name of slim nor the names of its
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

/**
 * This module is the entry point for the `open` command.
 */

const co = require("co");

/**
 * help text for the `open` command
 *
 * @property {String}
 */
exports.helpText = "make a repository visible locally";

/**
 * Configure the specified `parser` for the `open` command.
 *
 * @param {ArgumentParser} parser
 */
exports.configureParser = function (parser) {

    parser.addArgument(["path"], {
        type: "string",
        help: "path of one or more sub-repositories to open",
        nargs: "+",
    });
};

/**
 * Execute the `open` command according to the specified `args`.
 *
 * @param {Object} args
 * @param {String} args.path
 */
exports.executeableSubcommand = co.wrap(function *(args) {

    const GitUtil    = require("../slmu/slmu_gitutil");
    const open       = require("../slmu/slmu_open");
    const repo       = yield GitUtil.getCurrentRepo();
    const multimeter = require("multimeter");
    const multi      = multimeter(process.stdout);

    const openers = args.path.map((name, index) => {
        multi.write(name + "\n");
        // TODO: calc max length of sub-repo name
        //var bar = multi.rel(20, index, { width: 30 } );
        function progress(tp) {
            const received = tp.receivedObjects();
            const total = tp.totalObjects();
            console.log("%s: %d/%d", name, received, total);
            //bar.ratio(received, total, `(${received}/${total}) objects`);
        }
        return open.open(repo, name, progress);
    });
    console.log("here");
    yield openers;
    console.log("Did number 2");
});