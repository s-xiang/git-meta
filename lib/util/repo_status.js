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

/**
 * This modules defines the type `RepoStatus`, used to describe modifications
 * to a repo.
 */

/**
 * @enum {RepoStatus.STAGE}
 * indicates the meaning of an entry in the index
 */
// From libgit2 index.h.  This information is not documented in
// the nodegit or libgit2 documentation.
const STAGE = {
    NORMAL: 0,  // normally staged file
    OURS  : 2,  // our side of a stage
    THEIRS: 3,  // their side of a stage
};

/**
 * @enum {RepoStatus.FILESTATUS}
 * @static
 * indicates how a file was changed
 */
const FILESTATUS = {
    MODIFIED: 0,
    ADDED: 1,
    REMOVED: 2,
    CONFLICTED: 3,
    RENAMED: 4,
    TYPECHANGED: 5
};

/**
 * @class {RepoStatus.Submodule} a value-semantic type representing changes to
 * the state of a submodule
 */
class Submodule {

    /**
     * @constructor
     * Create a new `Submodule` object configured by the specified `status.
     * A non-null `indexStatus` indicates staged changes to this submodule.  A
     * non-null `repoStatus` indicates that the repository for this submodule
     * is visible.  The behavior is undefined if:
     *   - the submodule has been removed and contains `repoStatus` (open
     *     working directory), `indexSha`, or `indexUrl`
     *   - the status does not indicate removal and `indexSha` or `indexUrl`
     *     are null
     *   - the status indicates that the submodule was not just added but lacks
     *     commit information, having null `commitSha` or `commitUrl`.
     *   - the status indicates that the submodule was just added, but contains
     *     `commitSha` or `commitUrl`.
     *   - index modification is indicated, but the indicated shas and urls are
     *     the same in the index and commit
     *   - modification is not indicated, but the indicated shas or urls differ
     *     between index and commit
     *
     * @param {Object} status
     * @param {RepoStatus.FILESTATUS} [status.indexStatus]
     * @param {String}                [status.indexSha]
     * @param {String}                [status.indexUrl]
     * @param {String}                [status.commitSha]
     * @param {String}                [status.commitUrl]
     * @param {RepoStatus}            [repoStatus]
     */
    constructor(status) {
        assert.isObject(status);
        this.d_indexStatus = null;
        this.d_indexSha    = null;
        this.d_indexUrl    = null;
        this.d_commitSha   = null;
        this.d_commitUrl   = null;
        this.d_repoStatus  = null;

        if ("indexStatus" in status) {
            assert.isNumber(status.indexStatus);
            this.d_indexStatus = status.indexStatus;
        }
        if ("indexSha" in status) {
            assert.isString(status.indexSha);
            this.d_indexSha = status.indexSha;
        }
        if ("indexUrl" in status) {
            assert.isString(status.indexUrl);
            this.d_indexUrl = status.indexUrl;
        }
        if ("commitSha" in status) {
            assert.isString(status.commitSha);
            this.d_commitSha = status.commitSha;
        }
        if ("commitUrl" in status) {
            assert.isString(status.commitUrl);
            this.d_commitUrl = status.commitUrl;
        }
        if ("repoStatus" in status) {
            const RepoStatus = module.exports;
            assert.instanceOf(status.repoStatus, RepoStatus);
            this.d_repoStatus = status.repoStatus;
        }

        // If the submodule has been removed, then there must not be an index
        // sha or url and the repo cannot be open.  Otherwise, ther must be
        // index information.

        if (FILESTATUS.REMOVED === this.d_indexStatus) {
            assert.isNull(this.d_indexSha);
            assert.isNull(this.d_indexUrl);
            assert.isNull(this.d_repoStatus);
        }
        else {
            assert.isNotNull(this.d_indexSha);
            assert.isNotNull(this.d_indexUrl);
        }

        // There are commit sha and url if and only if the submodule hasn't
        // been added.

        if (FILESTATUS.ADDED === this.d_indexStatus) {
            assert.isNull(this.d_commitSha);
            assert.isNull(this.d_commitUrl);
        }
        else {
            assert.isNotNull(this.d_commitSha);
            assert.isNotNull(this.d_commitUrl);
        }

        // If there is a modification, then one of `indexSha` or `indexUrl`
        // must differ from the commit.

        if (FILESTATUS.MODIFIED === this.d_indexSha) {
            assert(this.d_commitSha !== this.d_indexSha ||
                   this.d_commitUrl !== this.d_indexUrl);
        }

        // No modification is indicated, but index and commit differ.

        if (null === this.d_indexStatus) {
            assert.equal(this.d_indexSha, this.d_commitSha);
            assert.equal(this.d_indexUrl, this.d_commitUrl);
        }

        Object.freeze(this);
    }

    /**
     * @property {RepoStatus.FILESTATUS} [indexStatus] state of this submodule
     * in the index.  Wil be null if no staged changes.
     */
    get indexStatus() {
        return this.d_indexStatus;
    }

    /**
     * @property {String} [indexSha] value for the submodule's sha in the
     * index.  Will be null if `FILESTATUS.REMOVED === indexStatus`.
     */
    get indexSha() {
        return this.d_indexSha;
    }

    /**
     * @property {String} [indexUrl] value for the submodule's url in the
     * index.  Will be null if `FILESTATUS.REMOVED === indexStatus`.
     */
    get indexUrl() {
        return this.d_indexUrl;
    }

    /**
     * @property {String} [commitSha] value for this repo's sha in the HEAD
     * commit.  Will be null if `FILESTATUS.ADDED === indexStatus`.
     */
    get commitSha() {
        return this.d_commitSha;
    }

    /**
     * @property {String} [commitUrl] value for this repo's url in the HEAD
     * commit.  Will be null if `FILESTATUS.ADDED === indexStatus`.
     */
    get commitUrl() {
        return this.d_commitUrl;
    }

    /**
     * @property {RepoStatus} [repoStatus] value for the open repository of
     * this submodule.  Non-null value indicates that the submodule is open.
     */
    get repoStatus() {
        return this.d_repoStatus;
    }
}

/**
 * @class {RepoStatus} value-semantic type representing changes to a
 * repository's index and working directory.
 */
class RepoStatus {

    /**
     * Return the `STAGE` for the specified `flags`.
     *
     * @static
     * @param {Number} flags
     * @return {STAGE}
     */
    static getStage(flags) {
        const GIT_IDXENTRY_STAGESHIFT = 12;
        return flags >> GIT_IDXENTRY_STAGESHIFT;
    }

    /**
     * Create a new status object having the specified properties.
     * @constructor
     *
     * @param {Object}   [args]
     * @param {String}   [args.currentBranchName]
     * @param {String}   [args.headCommit]
     * @param {Object}   [args.staged] map from name to `FILESTATUS`
     * @param {Object}   [args.submodules] map from name to `Submodule`
     * @param {Object}   [args.workdir] map from name to `FILESTATUS`
     * @param {String[]} [args.untracked]
     */
    constructor(args) {
        if (undefined === args) {
            args = {};
        }
        else {
            assert.isObject(args);
        }
        this.d_currentBranchName = null;
        this.d_headCommit = null;
        this.d_staged = {};
        this.d_workdir = {};
        this.d_untracked = [];
        this.d_submodules = {};

        if ("currentBranchName" in args) {
            if (null !== args.currentBranchName) {
                assert.isString(args.currentBranchName);
                this.d_currentBranchName = args.currentBranchName;
            }
        }
        if ("headCommit" in args) {
            if (null !== args.headCommit) {
                assert.isString(args.headCommit);
                this.d_headCommit = args.headCommit;
            }
        }
        if ("staged" in args) {
            const staged = args.staged;
            assert.isObject(staged);
            for (let name in staged) {
                const value = staged[name];
                assert.isNumber(value);
                this.d_staged[name] = value;
            }
        }
        if ("workdir" in args) {
            const workdir = args.workdir;
            assert.isObject(workdir);
            for (let name in workdir) {
                const value = workdir[name];
                assert.isNumber(value);
                this.d_workdir[name] = value;
            }
        }
        if ("untracked" in args) {
            const untracked = args.untracked;
            assert.isArray(untracked);
            untracked.forEach(path => {
                assert.isString(path);
                this.d_untracked.push(path);
            });
        }
        if ("submodules" in args) {
            const submodules = args.submodules;
            for (let name in submodules) {
                const submodule = submodules[name];
                assert.instanceOf(submodule, Submodule);
                this.d_submodules[name] = submodule;
            }
        }
        Object.freeze(this);
    }

    // ACCESSORS

    /**
     * Return true if there are no staged or modified files in this repository.
     * Note that untracked files and changes to submodules do not count as
     * modifications.
     *
     * @return {Boolean}
     */
    isClean() {
        return 0 === Object.keys(this.d_staged).length &&
            0 === Object.keys(this.d_workdir).length;
    }

    // PROPERTIES

    /**
     * @property {String} [currentBranchName] name of current branch or null
     *                                        if no current branch
     */
    get currentBranchName() {
        return this.d_currentBranchName;
    }

    /**
     * @property {String} [headCommit] sha of head commit or null if no
     * commit
     */
    get headCommit() {
        return this.d_headCommit;
    }

    /**
     * @property {Object} staged map from name to FILESTATUS
     */
    get staged() {
        return Object.assign({}, this.d_staged);
    }

    /**
     * @property {Object} submodules map from name to `Submodule`
     */
    get submodules() {
        return Object.assign({}, this.d_submodules);
    }

    /**
     * @property {Object} workdir files modified in working directory
     *                            a map from name to FILESTATUS
     */
    get workdir() {
        return Object.assign({}, this.d_workdir);
    }

    /**
     * @property {String []} untracked untracked files
     */
    get untracked() {
        return this.d_untracked.slice();
    }
}

module.exports = RepoStatus;
RepoStatus.STAGE = STAGE;
RepoStatus.FILESTATUS = FILESTATUS;
RepoStatus.Submodule = Submodule;

