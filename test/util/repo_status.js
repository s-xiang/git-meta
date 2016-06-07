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

const assert = require("chai").assert;

const RepoStatus= require("../../lib/util/repo_status");

describe("RepoStatus", function () {
    describe("Submodule", function () {
        const FILESTATUS = RepoStatus.FILESTATUS;
        const Submodule = RepoStatus.Submodule;

        function m(args) {
            const result = {
                indexStatus: null,
                indexSha: null,
                indexUrl: null,
                commitSha: null,
                commitUrl: null,
                repoStatus: null,
            };
            Object.assign(result, args);
            return result;
        }

        const cases = {
            "no changes": {
                args: {
                    indexSha: "1",
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                },
                expected: m({
                    indexSha: "1",
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                }),
            },
            "added": {
                args: {
                    indexStatus: FILESTATUS.ADDED,
                    indexUrl: "a",
                    indexSha: "1",
                },
                expected: m({
                    indexStatus: FILESTATUS.ADDED,
                    indexUrl: "a",
                    indexSha: "1",
                }),
            },
            "removed": {
                args: {
                    indexStatus: FILESTATUS.REMOVED,
                    commitUrl: "a",
                    commitSha: "1",
                },
                expected: m({
                    indexStatus: FILESTATUS.REMOVED,
                    commitUrl: "a",
                    commitSha: "1",
                }),
            },
            "modified": {
                args: {
                    indexStatus: FILESTATUS.MODIFIED,
                    indexSha: "2",
                    indexUrl: "2",
                    commitUrl: "a",
                    commitSha: "1",
                },
                expected: m({
                    indexStatus: FILESTATUS.MODIFIED,
                    indexSha: "2",
                    indexUrl: "2",
                    commitUrl: "a",
                    commitSha: "1",
                }),
            },
            "repo status": {
                args: {
                    repoStatus: new RepoStatus({
                        untracked: ["foo"],
                    }),
                    indexSha: "2",
                    indexUrl: "2",
                    commitUrl: "2",
                    commitSha: "2",
                },
                expected: m({
                    repoStatus: new RepoStatus({
                        untracked: ["foo"],
                    }),
                    indexSha: "2",
                    indexUrl: "2",
                    commitUrl: "2",
                    commitSha: "2",
                }),
            },
        };

        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = new Submodule(c.args);
                assert.instanceOf(result, Submodule);
                assert.isFrozen(result);
                const e = c.expected;
                assert.equal(result.indexStatus, e.indexStatus);
                assert.equal(result.indexSha, e.indexSha);
                assert.equal(result.indexUrl, e.indexUrl);
                assert.equal(result.commitSha, e.commitSha);
                assert.equal(result.commitUrl, e.commitUrl);
                assert.deepEqual(result.repoStatus, e.repoStatus);
            });
        });
    });

    describe("RepoStatus", function () {
        function m(args) {
            let result = {
                currentBranchName: null,
                headCommit: null,
                staged: {},
                workdir: {},
                untracked: [],
                submodules: {},
            };
            return Object.assign(result, args);
        }
        const cases = {
            "trivial, undefined": {
                args: undefined,
                e: m({}),
            },
            "all defaults": {
                args:  m({}),
                e: m({}),
            },
            "all specified": {
                args: {
                    currentBranchName: "foo",
                    headCommit: "1",
                    staged: { "x/y": RepoStatus.FILESTATUS.MODIFIED },
                    workdir: { "x/z": RepoStatus.FILESTATUS.REMOVED },
                    untracked: ["q"],
                    submodules: {
                        "a": new RepoStatus.Submodule({
                            indexSha: "1",
                            indexUrl: "a",
                            commitSha: "1",
                            commitUrl: "a",
                        }),
                    },
                },
                e: m({
                    currentBranchName: "foo",
                    headCommit: "1",
                    staged: { "x/y": RepoStatus.FILESTATUS.MODIFIED },
                    workdir: { "x/z": RepoStatus.FILESTATUS.REMOVED },
                    untracked: ["q"],
                    submodules: {
                        "a": new RepoStatus.Submodule({
                            indexSha: "1",
                            indexUrl: "a",
                            commitSha: "1",
                            commitUrl: "a",
                        }),
                    },
                }),
            }
        };

        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            const result = new RepoStatus(c.args);
            assert.instanceOf(result, RepoStatus);
            assert.isFrozen(result);
            assert.equal(result.currentBranchName, c.e.currentBranchName);
            assert.equal(result.headCommit, c.e.headCommit);
            assert.deepEqual(result.staged, c.e.staged);
            assert.deepEqual(result.workdir, c.e.workdir);
            assert.deepEqual(result.untracked, c.e.untracked);
            assert.deepEqual(result.submodules, c.e.submodules);
        });
    });

    describe("isClean", function () {
        const cases = {
            "trivial": {
                input: new RepoStatus(),
                expected: true,
            },
            "all possible and still clean": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    untracked: ["q"],
                    submodules: {
                        "a": new RepoStatus.Submodule({
                            indexSha: "1",
                            indexUrl: "a",
                            commitSha: "1",
                            commitUrl: "a",
                        }),
                    },
                }),
                expected: true,
            },
            "staged": {
                input: new RepoStatus({
                    staged: { x: RepoStatus.FILESTATUS.ADDED },
                }),
                expected: false,
            },
            "workdir": {
                input: new RepoStatus({
                    workdir: { x: RepoStatus.FILESTATUS.ADDED },
                }),
                expected: false,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = c.input.isClean();
                assert.equal(result, c.expected);
            });
        });
    });
});
