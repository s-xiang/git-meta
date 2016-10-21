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

# Git-meta

**NOTE Git-meta is BETA software**: Git-meta is open for collaboration, but
currently in a very early phase of development.  We will be adding features and
addressing shortcomings as we can, but Git-meta is not officially supported by
Two Sigma at this time.

___Build a *mono-repo* -- a single repository of unbounded size -- using Git
submodules.___

## Overview

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

## Mono-repo

### What is a mono-repo?

Philosophically, a mono-repo is a repository containing all of the source for
an organization.

A mono-repo looks like a standard, modern, version control system.  It presents
source in a single, hierarchical directory structure. A mono-repo supports
standard operations such as atomic commits and merges across the code it
contains.

Critically, in order to host all source for an organization, the performance of
a mono-repo must not degrade as it grows in terms of:

- history (number of commits)
- amount of code (number of files and bytes)
- number of developers

### What are the advantages of a mono-repo?

The alternative to a mono-repo is for an organization to decompose its source
into multiple unrelated repositories.  In comparison to a multi-repo strategy,
a mono-repo provides the following advantages:

- Atomic changes can be made across the organization's code.
- The history of the of an organization's source is described in a mono-repo.
  With multiple unrelated repositories, it is impossible to present a unified
  history.
- Because all source is described in one history, valuable operations such as
  `bisect` are easily supported.
- All source in the organization is easy to find.
- The use of a mono-repo encourages an organization to standardize on tools,
  e.g.: build and test.  When an organization has unrelated repositories that
  integrate at the binary level, its teams are more likely to adopt divergent
  build and test tools.
- The use of a mono-repo makes it easier to validate cross-organization builds
  and tests.

To summarize, the use of a single (mono) repository encourages collaboration
across an organization.  The use of multiple, unrelated, team-oriented
repositories encourages the use of divergent tooling and silos.

### Why doesn't everyone have a mono-repo?

Most organizations do not have a mono-repo because existing DVCS systems (e.g.,
Git and Mercurial) suffer performance degradation as the following increase:

- size of code -- e.g., can put pressure on disk capacity and performance
- number of files -- can make checkout operations slow and impact
  cross-repository operations like searching
- depth of history -- increases the amount of data present in clones
- number of refs (tags and branches) -- many operations scale linearly with the
  number of refs
- number of developers -- exacerbate other listed issues, and can cause
  contention on servers

Google has famously built its own proprietary mono-repo.  Before starting this
project, we investigated some potential open-source solutions:

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

Git submodules come the closest: they do provide the technical ability to solve
the problem, but are very difficult to use and lack some of the desired
features.  With git-meta, we will build on top of Git submodules to provide the
desired functionality leveraging existing Git commands.

