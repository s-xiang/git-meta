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

const assert  = require("chai").assert;

const RepoStatus = require("../../lib/util/repo_status");
const Status     = require("../../lib/util/status");

describe("Status", function () {

    describe("printFileStatuses", function () {
        // I don't want to try to test for the specific format, just that we
        // mention changed files.

        const STAT = RepoStatus.FILESTATUS;

        const cases = {
            "trivial": { input: new RepoStatus(), empty: true, },
            "with current branch": {
                input: new RepoStatus({ currenBranchName: "foo" }),
                empty: true,
            },
            "with head": {
                input: new RepoStatus({headCommit: "1"}),
                empty: true,
            },
            "with staged": {
                input: new RepoStatus({
                    staged: { "foo": STAT.ADDED },
                }),
                regex: /foo/,
            },
            "with workdir": {
                input: new RepoStatus({
                    workdir: { foobar: STAT.REMOVED },
                }),
                regex: /foobar/,
            },
            "with untracked": {
                input: new RepoStatus({
                    untracked: [ "uuuu"],
                }),
                regex: /uuuu/,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = Status.printFileStatuses(c.input);
                if (c.empty) {
                    assert.equal(result, "");
                }
                else {
                    assert.notEqual(result, "");
                    assert.match(result, c.regex);
                }
            });
        });
    });
});
