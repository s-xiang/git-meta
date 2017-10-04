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

const assert         = require("chai").assert;
const co             = require("co");
const NodeGit        = require("nodegit");

const Commit              = require("./commit");
const DoWorkQueue         = require("./do_work_queue");
const GitUtil             = require("./git_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleUtil       = require("./submodule_util");
const TreeUtil            = require("./tree_util");

const FILEMODE            = NodeGit.TreeEntry.FILEMODE;

/**
 * Return a string having the value of the specified `sha` with the "/"
 * character inserted between the second and third characters of `sha`.  The
 * behavior is undefined unless `sha` is at least three characters long.
 *
 * @param {String} sha
 * @return {String}
 */
exports.splitSha = function (sha) {
    const pre = sha.slice(0, 2);
    const post = sha.slice(2);
    return `${pre}/${post}`;
};

/**
 * Return the name of the ref used to indicate that the commit having the
 * specified `sha` has beren converted.
 *
 * @param {String} sha
 * @return {String}
 */
exports.convertedRefName = function (sha) {
    return "refs/stitched/converted/" + exports.splitSha(sha);
};

/**
 * Return the name of the ref indicating that the submodule commit having the
 * specified `subSha` has been fetched for the specified `metaSha`; this ref
 * also serves to root that submodule commit.
 *
 * @param {String} metaSha
 * @param {String} subSha
 * @return {String}
 */
exports.fetchedSubRefName = function (metaSha, subSha) {
    return "refs/stitched/fetched/" + exports.splitSha(metaSha) + "/sub/" +
        exports.splitSha(subSha);
};

/**
 * Return a summary for the specified `commit` for the submodule having the
 * specifiewd `name` to be used to describe changes that are rolled into a
 * meta-repo commit.
 *
 * @param {String} name
 * @param {Commit} subCommit
 */
exports.summarizeSubCommit = function (name, subCommit) {
    assert.isString(name);
    assert.instanceOf(subCommit, NodeGit.Commit);

    const author = subCommit.author();
    return `\
Includes changes from submodule ${name} on ${subCommit.id().tostrS()}.
Author: ${author.name()} <${author.email()}>
Date:   ${Commit.formatCommitTime(author.when())}

${subCommit.message()}
`;
};

/**
 * From a map containing a shas mapped to sets of direct parents, and the
 * specified starting `entry` sha, return a list of all shas ordered from least
 * to most dependent, that is, no sha will appear in the list before any of its
 * ancestors.  If no relation exists between two shas, they will be ordered
 * alphabetically.  Note that it is valid for a sha to exist as a parent from a
 * sha in `parentMap`, however, the behavior is undefined if there are entries
 * in 'parentMap' that are not reachable from 'entry'.
 *
 * @param {String} entry
 * @param {Object} parentMap  from sha to Set of its direct parents
 * @return {[String]}
 */
exports.listCommitsInOrder = function (entry, parentMap) {
    assert.isString(entry);
    assert.isObject(parentMap);

    // First, compute the levels of the commits.  A level '0' means that a
    // commit has no parents.  A level '1' means that a commit depends only on
    // commits with 0 parents, a level N means that a commit depends only on
    // commits with a level less than N.

    const levels = {};
    let queue = [entry];
    while (0 !== queue.length) {
        const next = queue[queue.length - 1];

        // Exit if we've already computed this one; can happen if one gets into
        // the queue more than once.

        if (next in levels) {
            queue.pop();
            continue;                                               // CONTINUE
        }
        let level = 0;
        const parents = parentMap[next] || [];
        for (let i = 0; i < parents.length; ++i) {
            const parent = parents[i];
            const parentLevel = levels[parent];
            if (undefined === parentLevel) {
                level = undefined;
                queue.push(parent);
            }
            else if (undefined !== level) {
                // If all parents computed thus far, recompute the max.  It can
                // not be less than or equal to any parent.

                level = Math.max(level, parentLevel + 1);
            }
        }
        if (undefined !== level) {
            // We were ab le to compute it, store and pop.

            levels[next] = level;
            queue.pop();
        }
    }

    // Now we sort, placing lowest level commits first.

    function compareCommits(a, b) {
        const aLevel = levels[a];
        const bLevel = levels[b];
        if (aLevel !== bLevel) {
            return aLevel - bLevel;                                   // RETURN
        }
        if (a < b) {
            return -1;                                                // RETURN
        }
        return 1;
    }
    return Object.keys(parentMap).sort(compareCommits);
};

/**
 * List, in order of least to most dependent, the specified `commit` and its
 * ancestors in the specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit} commit
 * @return {[NodeGit.Commit]}
 */
exports.listCommitsToStitch = co.wrap(function *(repo, commit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);

    const toList = [commit];
    const allParents = {};
    const commitMap = {};

    while (0 !== toList.length) {
        const next = toList[toList.length - 1];
        const nextSha = next.id().tostrS();
        toList.pop();

        // Skip processing commits we've seen.

        if (nextSha in allParents) {
            continue;                                               // CONTINUE
        }

        // If it's converted, so, implicitly, are its parents.

        const converted = yield exports.getConvertedSha(repo, nextSha);
        if (null !== converted) {
            continue;                                               // CONTINUE
        }
        const parents = yield next.getParents();
        const parentShas = [];
        for (let i = 0; i < parents.length; ++i) {
            const parent = parents[i];
            toList.push(parent);
            const parentSha = parent.id().tostrS();
            parentShas.push(parentSha);
        }
        allParents[nextSha] = parentShas;
        commitMap[nextSha] = next;
    }
    const commitShas = exports.listCommitsInOrder(commit.id().tostrS(),
                                                  allParents);
    return commitShas.map(sha => commitMap[sha]);
});

/**
 * Return the `TreeUtilChange` object corresponding to the `.gitmodules` file
 * synthesized in the specified `repo` from an original commit that had the
 * specified `urls`; this modules will will contain only those urls that are
 * excluded, i.e., for which the specified `exclude` returns true.
 *
 * @param {NodeGit.Repository}  repo
 * @param {Object}              urls    submodule name to url
 * @param {(String) => Boolean} exclude
 * @pram {TreeUtil.Change}
 */
exports.computeModulesFile = co.wrap(function *(repo, urls, exclude) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isObject(urls);
    assert.isFunction(exclude);

    const excludedUrls = {};
    for (let name in urls) {
        if (exclude(name)) {
            excludedUrls[name] = urls[name];
        }
    }
    const modulesText = SubmoduleConfigUtil.writeConfigText(excludedUrls);
    const db = yield repo.odb();
    const BLOB = 3;
    const id = yield db.write(modulesText, modulesText.length, BLOB);
    return new TreeUtil.Change(id, FILEMODE.BLOB);
});

/**
 * If the specified `sha` has been converted in the specified `repo`, return
 * the sha of the converted commit; otherwise, return null.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             sha
 * @return {String}
 */
exports.getConvertedSha = co.wrap(function *(repo, sha) {

    let ref;
    const refName = exports.convertedRefName(sha);
    try {
        ref = yield NodeGit.Reference.lookup(repo, refName);
    }
    catch (e) {
        return null;
    }
    return ref.target().tostrS();
});

/**
 * Return a map from submodule name to shas to list of objects containing the
 * fields:
 * - `metaSha` -- the meta-repo sha from which this subodule sha came
 * - `url`     -- url configured for the submodule
 * - `sha`     -- sha to fetch for the submodule
 * this map contains entries for all shas introduced in the specified `toFetch`
 * list in the specified `repo`.  Note that the behavior is undefined unless
 * `toFetch` is ordered from least to most dependent commits.  Perform at most
 * the specified `numParallel` operations in parallel.  Do not process entries
 * for submodules for which the specified `exclude` returns true.
 *
 * @param {NodeGit.Repository}  repo
 * @param {[NodeGit.Commit]}    toFetch
 * @param {(String) => Boolean} exclude
 * @param {Number}              numParallel
 * @return {Object}  map from submodule name -> { metaSha, url, sha }
 */
exports.listFetches = co.wrap(function *(repo, toFetch, exclude, numParallel) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isArray(toFetch);
    assert.isFunction(exclude);
    assert.isNumber(numParallel);

    let urls = {};

    // So that we don't have to continuously re-read the `.gitmodules` file, we
    // will assume that submodule URLs never change.

    const getUrl = co.wrap(function *(commit, sub) {
        let subUrl = urls[sub];

        // If we don't have the url for this submodule, load them.

        if (undefined === subUrl) {
            console.log("loading urls");
            const newUrls =
               yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, commit);
            urls = Object.assign(urls, newUrls);
            subUrl = urls[sub];
        }
        return subUrl;
    });

    const result = {};

    const commitChanges = {};

    const listChanges = co.wrap(function *(commit, i) {
        const changes = yield SubmoduleUtil.getSubmoduleChanges(repo, commit);
        commitChanges[commit.id().tostrS()] = changes;
        if (0 === i % 100) {
            console.log("Listed", i, "of", toFetch.length);
        }
    });

    yield DoWorkQueue.doInParallel(toFetch, listChanges, numParallel);

    const addTodo = co.wrap(function *(commit, subName, sha) {
        let subTodos = result[subName];
        if (undefined === subTodos) {
            subTodos = [];
            result[subName] = subTodos;
        }
        const subUrl = yield getUrl(commit, subName);
        subTodos.push({
            metaSha: commit.id().tostrS(),
            url: subUrl,
            sha: sha,
        });
    });

    toFetch = toFetch.slice().reverse();
    for (let i = 0; i < toFetch.length; ++i) {
        const commit = toFetch[i];
        const changes = commitChanges[commit.id().tostrS()];

        // look for added submodules

        const added = changes.added;
        for (let name in added) {
            if (!exclude(name)) {
                yield addTodo(commit, name, added[name]);
            }
        }

        // or changed submodules

        const changed = changes.changed;
        for (let name in changed) {
            if (!exclude(name)) {
                yield addTodo(commit, name, changed[name]["new"]);
            }
        }
    }
    return result;
});

/**
 * Write and return a new "stitched" commit for the specified `commit` in the
 * specified `repo`.  Record the specified `parents` as the parents of this
 * commit, along with the original submodule commits introduced by `commit`
 * originally, unless `true === detatched`.  If `detatched`, do not include the
 * originaly submodule commits as parents, but instead append their information
 * to the commit message of the generated commit.  If the specified `exclude`
 * function returns true for the path of a submodule, continue to treat it as a
 * submodule in the new commit and do not stitch it.
 *
 * Once the commit has been written, record a reference indicating the mapping
 * from the originally to new commit in the form of
 * `refs/stitched/converted/${sha}`, and clean the refs created in
 * `refs/stitched/fetched` for this commit.
 *
 * @param {NodeGit.Repository}  repo
 * @param {NodeGit.Commit}      commit
 * @param {[NodeGit.Commit]}    parents
 * @param {(String) => Boolean} exclude
 * @param {Boolean}             detatch
 * @return {NodeGit.Commit}
 */
exports.writeStitchedCommit = co.wrap(function *(repo,
                                                 commit,
                                                 parents,
                                                 exclude,
                                                 detatch) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    assert.isArray(parents);
    assert.isFunction(exclude);
    assert.isBoolean(detatch);

    let parentTree = null;
    if (0 !== parents.length) {
        const firstParent = parents[0];
        parentTree = yield firstParent.getTree();
    }

    // Unless `true === detatch`, the parents we'll write for this commit will
    // be a list containing first, the converted parents of the commit, then
    // the submodule commits it introduced.

    const parentsToWrite = parents.slice();
    let commitMessage = commit.message();

    const subChanges = yield SubmoduleUtil.getSubmoduleChanges(repo, commit);

    // changes and additions

    let updateModules = false;  // if any excluded subs added or removed
    const changes = {};

    const stitchSub = co.wrap(function *(name, sha) {
        let subCommit;
        try {
            subCommit = yield repo.getCommit(sha);
        }
        catch (e) {
            console.error("On meta-commit", commit.id().tostrS(),
                          name, "is missing", sha);
            return;                                                   // RETURN
        }
        const subTreeId = subCommit.treeId();
        changes[name] = new TreeUtil.Change(subTreeId, FILEMODE.TREE);

        if (detatch) {
            commitMessage += "\n";
            commitMessage += exports.summarizeSubCommit(name, subCommit);
        }
        else {
            parentsToWrite.push(subCommit);
        }
    });

    function changeExcluded(name, newSha) {
        const id = NodeGit.Oid.fromString(newSha);
        changes[name] = new TreeUtil.Change(id, FILEMODE.COMMIT);
    }

    const synthetics = [];  // list of submodules whose refs need cleaned up

    // added

    const added = subChanges.added;
    for (let name in added) {
        const newSha = added[name];
        if (exclude(name)) {
            updateModules = true;
            changeExcluded(name, newSha);
        }
        else {
            synthetics.push(name);
            yield stitchSub(name, newSha);
        }
    }

    // changed

    const changed = subChanges.changed;
    for (let name in changed) {
        const newSha = changed[name]["new"];
        if (exclude(name)) {
            changeExcluded(name, newSha);
        }
        else {
            synthetics.push(name);
            yield stitchSub(name, newSha);
        }
    }

    // removed

    const removed = subChanges.removed;
    for (let name in removed) {
        changes[name] = null;
        if (exclude(name)) {
            updateModules = true;
        }
    }

    // If any excluded submodules were added or removed, rewrite the modules
    // file.

    if (updateModules) {
        const newUrls =
               yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, commit);
        changes[SubmoduleConfigUtil.modulesFileName] =
                      yield exports.computeModulesFile(repo, newUrls, exclude);
    }

    const newTree = yield TreeUtil.writeTree(repo, parentTree, changes);
    const newCommitId = yield NodeGit.Commit.create(repo,
                                                    null,
                                                    commit.author(),
                                                    commit.committer(),
                                                    commit.messageEncoding(),
                                                    commitMessage,
                                                    newTree,
                                                    parentsToWrite.length,
                                                    parentsToWrite);
    const convertedRef = exports.convertedRefName(commit.id().tostrS());
    yield NodeGit.Reference.create(repo,
                                   convertedRef,
                                   newCommitId.tostrS(),
                                   1,
                                   "stitched a ref");
    return yield repo.getCommit(newCommitId);
});

/**
 * In the specified `repo`, perform the specified `subFetches`.  Use the
 * specified `url` to resolve relative submodule urls.  Each entry in the
 * `subFetches` array is an object containing the fields:
 * 
 * - url -- submodule configured url
 * - sha -- submodule sha
 * - metaSha -- sha it was introcued on
 *
 * @param {NodeGit.Repository}  repo
 * @param {String}              url
 * @param {[Object]}            subFetches
 */
exports.fetchSubCommits = co.wrap(function *(repo, url, subFetches) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(url);
    assert.isArray(subFetches);

    for (let i = 0; i < subFetches.length; ++i) {
        const fetch = subFetches[i];
        const subUrl = SubmoduleConfigUtil.resolveSubmoduleUrl(url, fetch.url);

        const sha = fetch.sha;
        try {
            yield GitUtil.fetchSha(repo, subUrl, sha);
        }
        catch (e) {
            console.log("Fetch of", subUrl, "failed:", e.message);
            return;                                               // RETURN
        }
        const refName = exports.fetchedSubRefName(fetch.metaSha, sha);
        yield NodeGit.Reference.create(repo, refName, sha, 1, "fetched");
    }
});
