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

In the first section of this document, we discuss the mono-repo.  We describe
key features and properties implied by the term, explain what makes
mono-repositories an attractive strategy for source code management, and also
why they are hard to implement, exploring some open source projects that are in
this space.  In short, the first section should explain why this problem is
worth solving and why there are no existing solutions.

The next section presents our architecture for implementing a mono-repo using
git submodules.  We describe the overall repository structure and
relationships, client- and server-specific concerns, and collaboration
strategies such as pull requests.

Finally, we discuss the tools provided by this project to support the proposed
architecture.  It is important to note that git-meta is built entirely on git:
it requires no extra servers, services, or databases and is not tied to any
specific git hosting solution.  There are two main sets of tools provided by
git-meta: programs intended to be run as server-side commit hooks to maintain
git-meta invariants and repository integrity; and a program intended to be used
as a git plugin on the client that simplifies interactions with submodules
(e.g., by providing a submodule-aware `merge` operation), and implements
other mono-repository aware functionality.

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
into multiple unrelated repositories.  In comparison to a multi-repo strategy,
a mono-repo provides the following advantages:

- Atomic changes can be made across the organization's code.
- The history of the of an organization's source is described in a mono-repo.
  With multiple unrelated repositories, it is impossible to present a unified
  history.
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

We will discuss the architecture of git-meta in more detail in the next
section, but essentially it provides a way to use standard git operations
across many repositories.  Before starting on git-meta, we did investigate
several existing products that take a similar approach:

[Gitslave](http://gitslave.sourceforge.net)

[myrepos](https://myrepos.branchable.com)

[Android Repo](https://source.android.com/source/using-repo.html)

[gclient](http://dev.chromium.org/developers/how-tos/depottools#TOC-gclient)

[Git subtrees](https://git-scm.com/book/en/v1/Git-Tools-Subtree-Merging)

[Git submodules](https://git-scm.com/docs/git-submodule)

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
features.  With git-meta, we will build on top of Git submodules to provide the
desired functionality leveraging existing Git commands.

## Git-meta Architecture

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
to point to `1a1a` and 1b1b`, respectively.  Our mono-repo has not yet been
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

#### Client-side behavior



A sub-module may be *opened* or *closed*; they are generally closed by after
cloning a meta-repo.  Developers open sub-repos as they need them.

Therefore, o
