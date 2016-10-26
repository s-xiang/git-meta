<!--
    Copyright (c) 2016, Two Sigma Open Source
    All rights reserved.

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.

    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.

    * Neither the name of git-meta nor the names of its
      contributors may be used to endorse or promote products derived from
      this software without specific prior written permission.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
    AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
    IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
    ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
    LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
    CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
    SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
    INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
    CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
    ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
    POSSIBILITY OF SUCH DAMAGE.
-->

**NOTE Git-meta is BETA software**: Git-meta is open for collaboration, but
currently in a very early phase of development.  We will be adding features and
addressing shortcomings as we can, but Git-meta is not officially supported by
Two Sigma at this time.

___Build a *mono-repo* -- a single repository of unbounded size -- using Git
submodules.___

# Overview

## What is git-meta?

Git-meta describes an architecture and provides a set of tools to facilitate
the implementation of a *mono-repo* and attendant workflows.

Aside from the ability to install the tools provided in this repository,
git-meta requires only Git.  Git-meta is not tied to any specific Git hosting
solution, and does not provide operations that are hosting-solution-specific,
such as the ability to create new (server-side) repositories.

## What is in the rest of this document?

In the first section of this document, we define the term *mono-repo*.  We
describe key features and properties of a mono-repo, explain what makes
mono-repos an attractive strategy for source code management, and also why they
are not found in most organizations, exploring some open source projects that
are in this space.  In short, the first section should explain why this problem
is worth solving and why there are no existing solutions.

The next section presents our architecture for implementing a mono-repo using
git submodules.  We describe the overall repository structure, solutions to
collaboration problems, name-partitioning strategies, and server-side
validations.

Finally, we discuss the two types of tools provided by this project to support
the proposed architecture: programs intended to be run as server-side commit
hooks to maintain git-meta invariants and repository integrity; and a program
intended to be used as a git plugin on the client that simplifies interactions
with submodules (e.g., by providing a submodule-aware `merge` operation), and
implements other mono-repo-aware functionality.

# Mono-repo

## What is a mono-repo?

A mono-repo is a repository containing all of the source for an organization.
It presents source in a single, hierarchical directory structure. A mono-repo
supports standard operations such as atomic commits and merges across the code
it contains.

Critically, in order to host all source for an organization, the performance of
a mono-repo must not degrade as it grows in terms of:

- history (number of commits)
- amount of code (number of files and bytes)
- number of developers

## What are the advantages of a mono-repo?

The alternative to a mono-repo is for an organization to decompose its source
into multiple repositories.  In comparison to a multi-repo strategy,
a mono-repo provides the following advantages:

- Atomic changes can be made across the organization's code.
- The history of the of an organization's source is described in a mono-repo.
  With multiple repositories, it is impossible to present a unified history.
- Because all source is described in one history, archaeological operations such
  as `bisect` are easily supported.
- Source in the organization is easy to find.
- The use of a mono-repo encourages an organization to standardize on tools,
  e.g.: build and test.  When an organization has unrelated repositories that
  integrate at the binary level, its teams are more likely to adopt divergent
  build and test tools.
- The use of a mono-repo makes it easier to validate cross-organization builds
  and tests.

To summarize, the use of a single (mono) repository encourages collaboration
across an organization.  The use of multiple, unrelated, team-oriented
repositories encourages the use of divergent tooling and silos.

## Why doesn't everyone have a mono-repo?

Most organizations do not have a mono-repo because existing DVCS systems (e.g.,
Git and Mercurial) suffer performance degradation as the size of the repository
and the number of users increase.  Over time, basic operations such as `git
status`, `git fetch`, etc. become slow enough that developers, given the
opportunity, will begin splitting code into multiple repositories.

We discuss the architecture of git-meta in more detail in the next section, but
essentially it provides a way to use standard git operations across many
repositories.  Before starting on git-meta, we did investigate several existing
products that take a similar approach:

- [Gitslave](http://gitslave.sourceforge.net)
- [myrepos](https://myrepos.branchable.com)
- [Android Repo](https://source.android.com/source/using-repo.html)
- [gclient](http://dev.chromium.org/developers/how-tos/depottools#TOC-gclient)
- [Git subtrees](https://git-scm.com/book/en/v1/Git-Tools-Subtree-Merging)
- [Git submodules](https://git-scm.com/docs/git-submodule)

All of these tools overlap with the problems git-meta is trying to solve, but
none of them are sufficient:

- most don't provide a way to reference the state of all repositories
  (Gitslave, Android Repo, Myrepos)
- some require a custom server (Android Repo)
- many are strongly focused on supporting a specific software platform (Android
  Repo, gclient)
- doesn't fully solve the scaling issue (Git subtrees)
- prohibitively difficult to use (Git submodules)
- lack scalable collaboration (e.g., pull request) strategies

Git submodules come the closest: they do provide the technical ability to solve
the problem, but are very difficult to use and lack some of the desired
features.  With git-meta, we build on top of Git submodules to provide the
desired functionality leveraging existing Git commands.

## Git-meta Architecture

In this section, we first provide an overview of the mono-repo. We describe its
structure, basic concerns such as commits, and performance.  Next, we discuss
ref name partitioning.  Then, we describe *synthetic-meta-refs* and the
problems they solve.  Finally, we describe integrity validations that must be
performed in server-side checks.

### Overview

#### Structure -- the meta-repo

Git-meta creates a logical mono-repo out of multiple *sub-repositories* (a.k.a.
sub-repo) by tying them together in a *meta-repository* (a.k.a. meta-repo) with
Git submodules.  Recall that a git submodule consists of the following:

1. a path at which to root the submodule in the referencing (meta) repository
1. the url of the referenced (sub) repository
1. the id of the "current" commit in the referenced (sub) repository

Thus, a meta-repo presents the entire source structure in a rooted directory
tree, and the state of the meta-repo unambiguously describes the complete
state of all sub-repos, i.e., the mono-repo:

```
'------------------------------------------------------------------------`
|                                                                        |
|  '-----------------------`                                             |
|  |                       |                                             |
|  |              foo/bar--|---------> [fafb http://foo-bar.git]         |
|  | meta-repo    foo/baz--|---------> [eeef http://foo-baz.git]         |
|  | a12f             zam--|---------> [aaba http://zam.git]             |
|  |                       |                                             |
|  `-----------------------,                                             |
|                                                                        |
`------------------------------------------------------------------------`
```

This meta-repo, for instance is currently on commit `a12f`.  It references
three sub-repos, rooted at: `foo/bar`, `foo/baz`, and `zam`.  The sub-repo
rooted at `foo/bar` lives in the url "http://foo-bar.git", and is currently on
commit `fafb`.

Note that git-meta allows users to put arbitrary files in the meta-repo (e.g.,
global configuration data), but for simplicity we ignore them in the rest of
this document.

#### Commits

Commits in sub-repos do not directly affect the state of the mono-repo.
Updating the mono-repo requires at least two commits: (1) a commit in one or
more sub-repos and (2) a commit in the meta-repo.  Say, for example, that we
make changes to the `foo/bar` and `foo/baz` repositories, updating their HEADs
to point to `1a1a` and `1b1b`, respectively.  Our mono-repo has not yet been
affected, and if you were to make a clone of the meta-repo described above, you
would see the same state diagrammed previously.  To update the mono-repo, a
commit must be made in the meta-repo, changing the mono-repo to look like,
e.g.:

```
'------------------------------------------------------------------------`
|                                                                        |
|  '-----------------------`                                             |
|  |                       |                                             |
|  |              foo/bar--|---------> [1a1a http://foo-bar.git]         |
|  | meta-repo    foo/baz--|---------> [1b1b http://foo-baz.git]         |
|  | 1c1c             zam--|---------> [aaba http://zam.git]             |
|  |                       |                                             |
|  `-----------------------,                                             |
|                                                                        |
`------------------------------------------------------------------------`
```

#### Refs

Only branches (and other refs, like tags) in the meta-repos are considered
significant to git-meta.  Users may create arbitrary branches in sub-repos, but
they are generally ignored by git-meta commands and workflows.

Git-meta itself creates and utilizes a special type of ref, called a
*syntetic-meta-ref* in sub-repos; we describe these in detail later.

#### Cloning, client-side representation

Users create local clones of a mono-repo by cloning the url of its meta-repo.
All sub-repos are *closed* by default.  When the user *opens* a sub-repo, it is
cloned and checked out.  Thus an initial clone requires downloading only
meta-information.  Subsequently, users need open only the sub-repos they need;
typically a small fraction of the organization's code.

#### Performance

At a minimum, users working in a mono-repo must download the meta-repo and all
sub-repos containing code that they require to work.

There is a commit in the meta-repo for every change made in the organization,
so the number of commits in the history of the meta-repo may be very large.
However, the information contained in each commit is relatively small,
generally indicating only changes to submodule pointers.  Furthermore, the
on-disk (checked out) rendering of the meta-repo is also small, being only a
file indicating the state of each sub-repo, and growing only as sub-repos are
added.  Therefore, the cost of cloning and checking out a meta-repo will be
relatively cheap, and scale slowly with the addition of new code -- especially
compared with the cost of doing the same operations in a single (physical)
repository.

Most other operations such as `checkout`, `commit`, `merge`, `status`, etc.
increase in cost with the number of files in open repositories on disk.
Therefore, the performance of a mono-repo will generally be determined by how
many files developers need to have on disk to do their work; this number can be
minimized through several strategies:

- decomposing large large sub-repos into multiple sub-repos as they become
  overly large
- minimizing dependencies -- if an organization's software is a giant
  interdependent ball, its developers may need most of its code on disk to work
- eliminate the need to open dependent sub-repos -- typically, a developer
  needs to open sub-repos that the need to (a) change, or (b) are build
  dependencies of sub-repos they need to change.  While outside the scope of
  git-meta, we are developing a proposal to address this case and will link to
  it here when ready.

### Name-partitioning

Git-meta works with a single meta-repo namespace, but we strongly recommend the
use of a name-partitioning strategy, generally either *forks* or [git
namespaces](https://git-scm.com/docs/gitnamespaces).  Otherwise, every user
will receive every branch in existence on every fetch/clone, causing
significant performance problems over time.

You must partition the namespace (through whichever method) in only the
meta-repo.  Partitions are unnecessary in sub-repos; as mentioned above,
git-meta does not interact with sub-repo ref names.  Furthermore, paritions
(whether forks or namespaces) are managed via remotes.  Managing and
synchronizing between the sets of remotes in the meta-repo and open sub-repos
would be complicated, error-prone, and confusing to users.

To prevent name partitionnig in sub-repos, you must either add sub-repos
with absolute URLs, or configure your server-side environment so that forked
sub-repo URLs automatically redirect to the single sub-repo URL.

### Synthetic-Meta-Refs

In this section, we describe our original (naive) branch collaboration strategy
and some problems it created.  Then we describe the *synthetic-meta-ref*, and
show how it provides a solution to the previously mentioned collaboration
problems.  Finally, we explore the ramifications of our synthetic-meta-ref
strategy on tooling, performance, and offline workflows.

#### Naive Collaboration Strategy

Our original collaboration strategy was fairly simple:

1. The meta-repo and open sub-repos would generally be on the same checked-out
   branch.
1. When pushing a ref, we would first push the ref with that name from open
   sub-repos, then from the meta-repo.
1. When landing pull-requests or doing other server-side validations, we would
   check that for a given meta-repo branch, we had corresponding valid
   sub-repo branches of the same name.
1. Sub-repo partitioning would follow meta-repo partitioning; for example, when
   a user "forked" the mono-repo, user-specific forks would be created for the
   meta-repo and each sub-repo.

This model created several problems:

##### Race conditions on collaboration branches

Git does not provide for atomic cross-repository operations.  So, our plan had
been to implement push such that we updated affected sub-repo branches first,
then the meta-repo branch.  Given the following scenario, where a user has new
(local) changes in three repositories:

```
Origin
'------------------------------------------------------------------------`
|                                                                        |
|  '-----------------------`                                             |
|  |                       |                                             |
|  |              foo/bar--|---------> [1a1a http://foo-bar.git]         |
|  | meta-repo    foo/baz--|---------> [1b1b http://foo-baz.git]         |
|  | 1c1c             zam--|---------> [aaba http://zam.git]             |
|  |                       |                                             |
|  `-----------------------,                                             |
|                                                                        |
`------------------------------------------------------------------------`

Local
'------------------------------------------------------------------------`
|                                                                        |
|  '-----------------------`                                             |
|  |                       |                                             |
|  |              foo/bar--|---------> [fafb http://foo-bar.git]         |
|  | meta-repo    foo/baz--|---------> [eeef http://foo-baz.git]         |
|  | a12f             zam--|---------> [aaba http://zam.git]             |
|  |                       |                                             |
|  `-----------------------,                                             |
|                                                                        |
`------------------------------------------------------------------------`
```



Furthermore, we would provide server-side
validation to reject attempts to update a meta-repo branch to a commit
contradicting the state of the corresponding sub-repo branch.  For example, if
a user pushed a change to branch `foo` in the meta-repo that updated repository
`bar` to be on commit `aaaa`, then the repository `bar` must have a branch
`foo` pointing to commit `aaaa` (or possibly another commit descended from
`aaaa`).  We recognized the ability for users to break integrity through force
pushes, but felt that this check would ensure that meta-repo collaboration
branches (where force-pushes would be disabled) remained in a valid state:
meta-repo commits would always indicate valid (present), rooted (against GC) in
the corresponding sub-repos.

We were correct, but unfortunately, this strategy suffers from a potential race
condition that could put a branch into a state such that it could no longer be
updated, and that users could not correct.
