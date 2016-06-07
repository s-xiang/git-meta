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

    describe("printSubmoduleStatus", function () {
        // I don't want to try to test for the specific format, just that we
        // mention changes.

        const Submodule = RepoStatus.Submodule;
        const RELATION = Submodule.COMMIT_RELATION;
        const STAT = RepoStatus.FILESTATUS;

        const cases = {
            "unchanged": { 
                input: new Submodule({
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                }),
                regex: null,
            },
            "removed": { 
                input: new Submodule({
                    indexStatus: STAT.REMOVED,
                    commitSha: "1",
                    commitUrl: "a",
                }),
                regex: /Removed/,
            },
            "added": {
                input: new Submodule({
                    indexStatus: STAT.ADDED,
                    indexUrl: "xyz",
                    indexSha: "1",
                }),
                regex: /Added.*xyz/,
            },
            "changed url": {
                input: new Submodule({
                    indexStatus: STAT.MODIFIED,
                    indexUrl: "qrs",
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    commitUrl: "xyz",
                    commitSha: "1",
                }),
                regex: /Staged change to URL.*qrs/,
            },
            "new commit staged": {
                input: new Submodule({
                    indexStatus: STAT.MODIFIED,
                    indexUrl: "x",
                    indexSha: "2",
                    indexShaRelation: RELATION.AHEAD,
                    commitUrl: "x",
                    commitSha: "1",
                }),
                regex: /New commit/,
            },
            "old commit staged": {
                input: new Submodule({
                    indexStatus: STAT.MODIFIED,
                    indexUrl: "x",
                    indexSha: "2",
                    indexShaRelation: RELATION.BEHIND,
                    commitUrl: "x",
                    commitSha: "1",
                }),
                regex: /Reset to old commit/,
            },
            "unrelated staged": {
                input: new Submodule({
                    indexStatus: STAT.MODIFIED,
                    indexUrl: "x",
                    indexSha: "2",
                    indexShaRelation: RELATION.UNRELATED,
                    commitUrl: "x",
                    commitSha: "1",
                }),
                regex: /Changed to unrelated commit/,
            },
            "new head commit": {
                input: new Submodule({
                    indexUrl: "x",
                    indexSha: "2",
                    indexShaRelation: RELATION.SAME,
                    commitUrl: "x",
                    commitSha: "2",
                    workdirShaRelation: RELATION.AHEAD,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                    }),
                }),
                regex: /New commit/
            },
            "new head commit in new submodule": {
                input: new Submodule({
                    indexStatus: STAT.ADDED,
                    indexUrl: "x",
                    indexSha: "2",
                    workdirShaRelation: RELATION.AHEAD,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                    }),
                }),
                regex: /New commit/
            },
            "behind head commit": {
                input: new Submodule({
                    indexUrl: "x",
                    indexSha: "2",
                    indexShaRelation: RELATION.SAME,
                    commitUrl: "x",
                    commitSha: "2",
                    workdirShaRelation: RELATION.BEHIND,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                    }),
                }),
                regex: /Open repo has old commit/
            },
            "unrelated head commit": {
                input: new Submodule({
                    indexUrl: "x",
                    indexSha: "2",
                    indexShaRelation: RELATION.SAME,
                    commitUrl: "x",
                    commitSha: "2",
                    workdirShaRelation: RELATION.UNRELATED,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                    }),
                }),
                regex: /Open repo has unrelated commit/
            },
            "file statuses": {
                // We forward this, just validate that it does so.
                input: new Submodule({
                    indexStatus: STAT.ADDED,
                    indexSha: "1",
                    indexUrl: "a",
                    workdirShaRelation: RELATION.SAME,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                        staged: { foo: STAT.ADDED },
                    })
                }),
                regex: /foo/,
            },
            "bad branch": {
                input: new Submodule({
                    indexStatus: STAT.ADDED,
                    indexSha: "1",
                    indexUrl: "a",
                    workdirShaRelation: RELATION.SAME,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                        currentBranchName: "bar",
                    })
                }),
                branch: "foo",
                regex: /On wrong branch.*bar/,
            },
            "no branch": {
                input: new Submodule({
                    indexStatus: STAT.ADDED,
                    indexSha: "1",
                    indexUrl: "a",
                    workdirShaRelation: RELATION.SAME,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                    })
                }),
                branch: "foo",
                regex: /not on a branch/,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const branch = c.branch || null;
                const result = Status.printSubmoduleStatus(branch, c.input);
                if (c.regex) {
                    assert.notEqual(result, "");
                    assert.match(result, c.regex);
               }
                else {
                    assert.equal(result, "");
                }
            });
        });
    });

});
