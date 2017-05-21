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
const colors  = require("colors");
const NodeGit = require("nodegit");

const Open          = require("./open");
const RepoStatus    = require("./repo_status");
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

const metaStashRef = "refs/meta-stash";

function makeSubRefName(sha) {
    return `refs/sub-stash/${sha}`;
}

/**
 * Save the state of the submodules in the specified, `repo` having the
 * specified `status` and clean the sub-repositories to match their respective
 * HEAD commits.  If the specified `all` is true, include untracked files in
 * the stash and clean them.  Do not stash any information for the meta-repo
 * itself.  Update the `refs/meta-stash` reference and its reflog to point to a
 * new stash commit.  This commit will have the current HEAD of the repository
 * as its child, and a tree with containing updated shas for stashed submodules
 * pointing to their respective stash commits.  In each stashed submodule,
 * crete a synthetic-meta-ref in the form of `refs/sub-stash/${sha}`, where
 * `sha` is the stash commit of that submodule.  Return a map from submodule
 * name to stashed commit for each submodule that was stashed.
 *
 * @param {NodeGit.Repository} repo
 * @param {RepoStatus}         status
 * @param {Boolean}            all
 * @return {Object}    submodule name to stashed commit
 */
exports.save = co.wrap(function *(repo, status, all) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(status, RepoStatus);
    assert.isBoolean(all);

    const subResults = {};  // name to sha
    const subChanges = {};  // name to TreeUtil.Change
    const subRepos   = {};  // name to submodule open repo

    const sig = repo.defaultSignature();

    // First, we process the submodules.  If a submodule is open and dirty,
    // we'll create the stash commits in its repo, populate `subResults` with
    // the `Stash.Submodule` that will be returned, `subChanges` with the sha
    // of the commit to be made to be used in generating the new submodule
    // tree, and `subRepos` to cache the open repo for each sub to be used
    // later.

    const submodules = status.submodules;
    yield Object.keys(submodules).map(co.wrap(function *(name) {
        const sub = submodules[name];
        const wd = sub.workdir;
        if (null === wd ||
            (wd.status.isClean() &&
                (!all || 0 === Object.keys(wd.status.workdir).length))) {
            // Nothing to do for closed or clean subs

            return;                                                   // RETURN
        }
        const subRepo = yield SubmoduleUtil.getRepo(repo, name);
        subRepos[name] = subRepo;
        const FLAGS = NodeGit.Stash.FLAGS;
        const flags = all ? FLAGS.INCLUDE_UNTRACKED : FLAGS.DEFAULT;
        const stashId = yield NodeGit.Stash.save(subRepo, sig, "stash", flags);
        subResults[name] = stashId.tostrS();

        // Record the values we've created.

        subChanges[name] = new TreeUtil.Change(
                                            stashId,
                                            NodeGit.TreeEntry.FILEMODE.COMMIT);
    }));
    const head = yield repo.getHeadCommit();
    const headTree = yield head.getTree();
    const subsTree = yield TreeUtil.writeTree(repo, headTree, subChanges);
    const stashId = yield NodeGit.Commit.create(repo,
                                                null,
                                                sig,
                                                sig,
                                                null,
                                                "stash",
                                                subsTree,
                                                1,
                                                [head]);

    const stashSha = stashId.tostrS();

    // Make synthetic-meta-ref style refs for sub-repos.

    yield Object.keys(subRepos).map(co.wrap(function *(name) {
        const sha = subResults[name];
        const refName = makeSubRefName(sha);
        yield NodeGit.Reference.create(subRepos[name],
                                       refName,
                                       sha,
                                       1,
                                       "sub stash");
    }));

    // Update the stash ref and the ref log

    yield NodeGit.Reference.create(repo,
                                   metaStashRef,
                                   stashId,
                                   1,
                                   "meta stash");

    yield exports.appendReflog(repo, metaStashRef, stashSha);
    return subResults;
});

/**
 * Append an entry to the log for the specified `reference` in the specified
 * `repo`, pointing to the specified `sha`.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             reference
 * @param {String}             sha
 */
exports.appendReflog = co.wrap(function *(repo, reference, sha) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(reference);
    assert.isString(sha);
    const log = yield NodeGit.Reflog.read(repo, reference);
    log.append(NodeGit.Oid.fromString(sha), repo.defaultSignature(), "log");
    log.write();
});

/**
 * Make the commit having the specified `sha` be the top of the stash of the
 * specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             sha
 */
exports.setStashHead = co.wrap(function *(repo, sha) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(sha);
    let currentRef;
    try {
        currentRef = yield NodeGit.Reference.lookup(repo, "refs/stash");
    }
    catch (e) {
        // ref doesn't exist
    }
    if (undefined !== currentRef && currentRef.target().tostrS() === sha) {
        // if the stash already points to `sha`, bail

        return;                                                       // RETURN
    }

    // otherwise, either there is no stash, or it points to the wrong thing

    yield NodeGit.Reference.create(repo, "refs/stash", sha, 1, "stash");
    yield exports.appendReflog(repo, "refs/stash", sha);
});

/**
 * Restore the meta stash having the specified commit `id` in the specified
 * `repo` and return a map from submodule name to the sha of its stash for each
 * submodule restored on success, or null if one or more submodules could not
 * be restored.  The behavior is undefined unless `id` identifies a valid stash
 * commit.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             id
 * @return {Boolean}
 */
exports.apply = co.wrap(function *(repo, id) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(id);

    const commit = yield repo.getCommit(id);

    // TODO: patch libgit2/nodegit: the commit object returned from `parent`
    // isn't properly configured with a `repo` object, and attempting to use it
    // in `getSubmodulesForCommit` will fail, so we have to look it up.

    const parentId = (yield commit.parent(0)).id();
    const parent = yield repo.getCommit(parentId);
    const baseSubs = yield SubmoduleUtil.getSubmodulesForCommit(repo, parent);
    const newSubs = yield SubmoduleUtil.getSubmodulesForCommit(repo, commit);
    const opener = new Open.Opener(repo, null);
    let result = {};
    yield Object.keys(newSubs).map(co.wrap(function *(name) {
        const stashSha = newSubs[name].sha;
        if (baseSubs[name].sha === stashSha) {
            // If there is no change in sha, then there is no stash

            return;                                                   // RETURN
        }
        const subRepo = yield opener.getSubrepo(name);

        // Try to get the comit for the stash; if it's missing, fail.

        try {
            yield subRepo.getCommit(stashSha);
        }
        catch (e) {
            console.error(`\
Stash commit ${colors.red(stashSha)} is missing from submodule \
${colors.red(name)}`);
            result = null;
            return;                                                   // RETURN
        }

        // Make sure this sha is the current stash.

        yield exports.setStashHead(subRepo, stashSha);

        // And then apply it.

        try {
            yield NodeGit.Stash.pop(subRepo, 0);
        }
        catch (e) {
            result = null;
        }
        if (null !== result) {
            result[name] = stashSha;
        }
    }));
    return result;
});
