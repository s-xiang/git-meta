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

const assert  = require("chai").assert;
const co      = require("co");
const NodeGit = require("nodegit");

const RepoStatus    = require("./repo_status");
const Stash         = require("./stash");
const SubmoduleUtil = require("./submodule_util");
const TreeUtil      = require("./tree_util");

/**
 * Return the IDs of tress reflecting the current state of the index and
 * workdir for the specified `repo`, having the specified `status`.  If the
 * specified `all` is provided, include untracked files.
 *
 * @param {NodeGit.Repository} repo
 * @param {RepoStatus}         status
 * @param {Boolean}            all
 * @return {Object}
 * @return {NodeGit.Oid} return.index
 * @return {NodeGit.Oid} return.workdir
 */
exports.stashRepo = co.wrap(function *(repo, status, all) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(status, RepoStatus);
    assert.isBoolean(all);

    // Get a tree for the index

    const index = yield repo.index();
    const indexId = yield index.writeTree();

    // Create a tree for the workdir based on the index.

    const indexTree = yield NodeGit.Tree.lookup(repo, indexId);
    const changes = TreeUtil.listWorkdirChanges(repo, status, all);
    const workdirTree = yield TreeUtil.writeTree(repo, indexTree, changes);

    return {
        index: indexId,
        workdir: workdirTree.id(),
    };
});

/**
 * Save the state of the submodules in the specified, `repo` having the
 * specified `status`, return a `Stash` object describing the created stash
 * commits, and clean the sub-repositories to match their respective HEAD
 * commits.  If the specified `all` is true, include untracked files in the
 * stash and clean them from the working directory.  Do not stash any
 * information relevant to the meta-repo for now as this is not supported;
 * instead, record the tree for the HEAD commit as both workdir and index
 * state, reflecting no change.
 *
 * @param {NodeGit.Repository} repo
 * @param {RepoStatus}         status
 * @param {Boolean}            all
 * @return {Stash}
 */
exports.save = co.wrap(function *(repo, status, all) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(status, RepoStatus);
    assert.isBoolean(all);

    const head = yield repo.getHeadCommit();
    const sig = repo.defaultSignature();

    const createCommit = co.wrap(function *(r, tree, message, parents) {
        const id = yield NodeGit.Commit.create(r,
                                               null,
                                               sig,
                                               sig,
                                               null,
                                               message,
                                               tree,
                                               parents.length,
                                               parents);
        return yield r.getCommit(id);
    });

    const headTree = yield head.getTree();

    const subResults = {};  // name to Stash.Submodule
    const subChanges = {};  // name to TreeUtil.Change
    const subRepos   = {};  // name to NodeGit.Repository

    const submodules = status.submodules;
    yield Object.keys(submodules).map(co.wrap(function *(name) {
        const sub = submodules[name];
        const wd = sub.workdir;
        if (null === wd || wd.status.isClean()) {
            // Nothing to do for closed or clean subs

            return;                                                   // RETURN
        }
        const subRepo = yield SubmoduleUtil.getRepo(repo, name);
        subRepos[name] = subRepo;
        const head = yield subRepo.getHeadCommit();
        const stashed = yield exports.stashRepo(subRepo, wd.status, all);
        const indexTree = yield NodeGit.Tree.lookup(subRepo, stashed.index);
        const wdTree = yield NodeGit.Tree.lookup(subRepo, stashed.workdir);
        const indexCommit = yield createCommit(subRepo,
                                               indexTree,
                                               "index",
                                               []);
        const commit = yield createCommit(subRepo,
                                          wdTree,
                                          "stash",
                                          [head, indexCommit]);
        yield NodeGit.Reference.create(subRepo,
                                       "refs/sub-stash",
                                       commit.id(),
                                       1,
                                       "sub stash");
        subResults[name] = new Stash.Submodule(indexCommit.id().tostrS(),
                                               commit.id().tostrS());
        subChanges[name] = new TreeUtil.Change(
                                            commit.id(),
                                            NodeGit.TreeEntry.FILEMODE.COMMIT);
    }));

    const indexCommit = yield createCommit(repo, headTree, "index", []);
    const subsTree = yield TreeUtil.writeTree(repo, headTree, subChanges);
    const subsCommit = yield createCommit(repo, subsTree, "submodules", []);
    const stashCommit = yield createCommit(repo,
                                           headTree,
                                           "stash",
                                           [head, indexCommit, subsCommit]);
    yield NodeGit.Reference.create(repo,
                                   "refs/meta-stash",
                                   stashCommit.id(),
                                   1,
                                   "meta stash");

    // Now that we've made all the stashes, clean dirty repos.

    yield Object.keys(subRepos).map(co.wrap(function *(name) {
        const subRepo = subRepos[name];
        const head = yield subRepo.getHeadCommit();
        yield NodeGit.Checkout.tree(subRepo, head, {
            checkoutStrategy: NodeGit.Checkout.STRATEGY.FORCE,
        });
    }));

    return new Stash(indexCommit.id().tostrS(),
                     subResults,
                     subsCommit.id().tostrS(),
                     stashCommit.id().tostrS());
});
