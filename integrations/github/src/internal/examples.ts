import { WebhookExample } from "@trigger.dev/integration-sdk/types";

const commit_comment = {};

export const examples: Record<string, WebhookExample> = {
  commit_comment: {
    name: "Commit created event",
    payload: {
      action: "created",
      comment: {
        url: "https://api.github.com/repos/Codertocat/Hello-World/comments/33548674",
        html_url:
          "https://github.com/Codertocat/Hello-World/commit/6113728f27ae82c7b1a177c8d03f9e96e0adf246#commitcomment-33548674",
        id: 33548674,
        node_id: "MDEzOkNvbW1pdENvbW1lbnQzMzU0ODY3NA==",
        user: {
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        position: null,
        line: null,
        path: null,
        commit_id: "6113728f27ae82c7b1a177c8d03f9e96e0adf246",
        created_at: "2019-05-15T15:20:39Z",
        updated_at: "2019-05-15T15:20:39Z",
        author_association: "OWNER",
        body: "This is a really good change! :+1:",
      },
      repository: {
        id: 186853002,
        node_id: "MDEwOlJlcG9zaXRvcnkxODY4NTMwMDI=",
        name: "Hello-World",
        full_name: "Codertocat/Hello-World",
        private: false,
        owner: {
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        html_url: "https://github.com/Codertocat/Hello-World",
        description: null,
        fork: false,
        url: "https://api.github.com/repos/Codertocat/Hello-World",
        forks_url: "https://api.github.com/repos/Codertocat/Hello-World/forks",
        keys_url:
          "https://api.github.com/repos/Codertocat/Hello-World/keys{/key_id}",
        collaborators_url:
          "https://api.github.com/repos/Codertocat/Hello-World/collaborators{/collaborator}",
        teams_url: "https://api.github.com/repos/Codertocat/Hello-World/teams",
        hooks_url: "https://api.github.com/repos/Codertocat/Hello-World/hooks",
        issue_events_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/events{/number}",
        events_url:
          "https://api.github.com/repos/Codertocat/Hello-World/events",
        assignees_url:
          "https://api.github.com/repos/Codertocat/Hello-World/assignees{/user}",
        branches_url:
          "https://api.github.com/repos/Codertocat/Hello-World/branches{/branch}",
        tags_url: "https://api.github.com/repos/Codertocat/Hello-World/tags",
        blobs_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/blobs{/sha}",
        git_tags_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/tags{/sha}",
        git_refs_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/refs{/sha}",
        trees_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/trees{/sha}",
        statuses_url:
          "https://api.github.com/repos/Codertocat/Hello-World/statuses/{sha}",
        languages_url:
          "https://api.github.com/repos/Codertocat/Hello-World/languages",
        stargazers_url:
          "https://api.github.com/repos/Codertocat/Hello-World/stargazers",
        contributors_url:
          "https://api.github.com/repos/Codertocat/Hello-World/contributors",
        subscribers_url:
          "https://api.github.com/repos/Codertocat/Hello-World/subscribers",
        subscription_url:
          "https://api.github.com/repos/Codertocat/Hello-World/subscription",
        commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/commits{/sha}",
        git_commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/commits{/sha}",
        comments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/comments{/number}",
        issue_comment_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/comments{/number}",
        contents_url:
          "https://api.github.com/repos/Codertocat/Hello-World/contents/{+path}",
        compare_url:
          "https://api.github.com/repos/Codertocat/Hello-World/compare/{base}...{head}",
        merges_url:
          "https://api.github.com/repos/Codertocat/Hello-World/merges",
        archive_url:
          "https://api.github.com/repos/Codertocat/Hello-World/{archive_format}{/ref}",
        downloads_url:
          "https://api.github.com/repos/Codertocat/Hello-World/downloads",
        issues_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues{/number}",
        pulls_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls{/number}",
        milestones_url:
          "https://api.github.com/repos/Codertocat/Hello-World/milestones{/number}",
        notifications_url:
          "https://api.github.com/repos/Codertocat/Hello-World/notifications{?since,all,participating}",
        labels_url:
          "https://api.github.com/repos/Codertocat/Hello-World/labels{/name}",
        releases_url:
          "https://api.github.com/repos/Codertocat/Hello-World/releases{/id}",
        deployments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/deployments",
        created_at: "2019-05-15T15:19:25Z",
        updated_at: "2019-05-15T15:20:34Z",
        pushed_at: "2019-05-15T15:20:33Z",
        git_url: "git://github.com/Codertocat/Hello-World.git",
        ssh_url: "git@github.com:Codertocat/Hello-World.git",
        clone_url: "https://github.com/Codertocat/Hello-World.git",
        svn_url: "https://github.com/Codertocat/Hello-World",
        homepage: null,
        size: 0,
        stargazers_count: 0,
        watchers_count: 0,
        language: "Ruby",
        has_issues: true,
        has_projects: true,
        has_downloads: true,
        has_wiki: true,
        has_pages: true,
        forks_count: 0,
        mirror_url: null,
        archived: false,
        disabled: false,
        open_issues_count: 2,
        license: null,
        forks: 0,
        open_issues: 2,
        watchers: 0,
        default_branch: "master",
      },
      sender: {
        login: "Codertocat",
        id: 21031067,
        node_id: "MDQ6VXNlcjIxMDMxMDY3",
        avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
        gravatar_id: "",
        url: "https://api.github.com/users/Codertocat",
        html_url: "https://github.com/Codertocat",
        followers_url: "https://api.github.com/users/Codertocat/followers",
        following_url:
          "https://api.github.com/users/Codertocat/following{/other_user}",
        gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
        starred_url:
          "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
        subscriptions_url:
          "https://api.github.com/users/Codertocat/subscriptions",
        organizations_url: "https://api.github.com/users/Codertocat/orgs",
        repos_url: "https://api.github.com/users/Codertocat/repos",
        events_url: "https://api.github.com/users/Codertocat/events{/privacy}",
        received_events_url:
          "https://api.github.com/users/Codertocat/received_events",
        type: "User",
        site_admin: false,
      },
    },
  },
  issues: {
    name: "An issue is modified",
    payload: {
      action: "edited",
      issue: {
        url: "https://api.github.com/repos/Codertocat/Hello-World/issues/1",
        repository_url: "https://api.github.com/repos/Codertocat/Hello-World",
        labels_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/1/labels{/name}",
        comments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/1/comments",
        events_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/1/events",
        html_url: "https://github.com/Codertocat/Hello-World/issues/1",
        id: 444500041,
        node_id: "MDU6SXNzdWU0NDQ1MDAwNDE=",
        number: 1,
        title: "Spelling error in the README file",
        user: {
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        labels: [
          {
            id: 1362934389,
            node_id: "MDU6TGFiZWwxMzYyOTM0Mzg5",
            url: "https://api.github.com/repos/Codertocat/Hello-World/labels/bug",
            name: "bug",
            color: "d73a4a",
            default: true,
          },
        ],
        state: "open",
        locked: false,
        assignee: {
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        assignees: [
          {
            login: "Codertocat",
            id: 21031067,
            node_id: "MDQ6VXNlcjIxMDMxMDY3",
            avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
            gravatar_id: "",
            url: "https://api.github.com/users/Codertocat",
            html_url: "https://github.com/Codertocat",
            followers_url: "https://api.github.com/users/Codertocat/followers",
            following_url:
              "https://api.github.com/users/Codertocat/following{/other_user}",
            gists_url:
              "https://api.github.com/users/Codertocat/gists{/gist_id}",
            starred_url:
              "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
            subscriptions_url:
              "https://api.github.com/users/Codertocat/subscriptions",
            organizations_url: "https://api.github.com/users/Codertocat/orgs",
            repos_url: "https://api.github.com/users/Codertocat/repos",
            events_url:
              "https://api.github.com/users/Codertocat/events{/privacy}",
            received_events_url:
              "https://api.github.com/users/Codertocat/received_events",
            type: "User",
            site_admin: false,
          },
        ],
        milestone: {
          url: "https://api.github.com/repos/Codertocat/Hello-World/milestones/1",
          html_url: "https://github.com/Codertocat/Hello-World/milestone/1",
          labels_url:
            "https://api.github.com/repos/Codertocat/Hello-World/milestones/1/labels",
          id: 4317517,
          node_id: "MDk6TWlsZXN0b25lNDMxNzUxNw==",
          number: 1,
          title: "v1.0",
          description: "Add new space flight simulator",
          creator: {
            login: "Codertocat",
            id: 21031067,
            node_id: "MDQ6VXNlcjIxMDMxMDY3",
            avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
            gravatar_id: "",
            url: "https://api.github.com/users/Codertocat",
            html_url: "https://github.com/Codertocat",
            followers_url: "https://api.github.com/users/Codertocat/followers",
            following_url:
              "https://api.github.com/users/Codertocat/following{/other_user}",
            gists_url:
              "https://api.github.com/users/Codertocat/gists{/gist_id}",
            starred_url:
              "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
            subscriptions_url:
              "https://api.github.com/users/Codertocat/subscriptions",
            organizations_url: "https://api.github.com/users/Codertocat/orgs",
            repos_url: "https://api.github.com/users/Codertocat/repos",
            events_url:
              "https://api.github.com/users/Codertocat/events{/privacy}",
            received_events_url:
              "https://api.github.com/users/Codertocat/received_events",
            type: "User",
            site_admin: false,
          },
          open_issues: 1,
          closed_issues: 0,
          state: "closed",
          created_at: "2019-05-15T15:20:17Z",
          updated_at: "2019-05-15T15:20:18Z",
          due_on: "2019-05-23T07:00:00Z",
          closed_at: "2019-05-15T15:20:18Z",
        },
        comments: 0,
        created_at: "2019-05-15T15:20:18Z",
        updated_at: "2019-05-15T15:20:18Z",
        closed_at: null,
        author_association: "OWNER",
        body: "It looks like you accidently spelled 'commit' with two 't's.",
      },
      changes: {},
      repository: {
        id: 186853002,
        node_id: "MDEwOlJlcG9zaXRvcnkxODY4NTMwMDI=",
        name: "Hello-World",
        full_name: "Codertocat/Hello-World",
        private: false,
        owner: {
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        html_url: "https://github.com/Codertocat/Hello-World",
        description: null,
        fork: false,
        url: "https://api.github.com/repos/Codertocat/Hello-World",
        forks_url: "https://api.github.com/repos/Codertocat/Hello-World/forks",
        keys_url:
          "https://api.github.com/repos/Codertocat/Hello-World/keys{/key_id}",
        collaborators_url:
          "https://api.github.com/repos/Codertocat/Hello-World/collaborators{/collaborator}",
        teams_url: "https://api.github.com/repos/Codertocat/Hello-World/teams",
        hooks_url: "https://api.github.com/repos/Codertocat/Hello-World/hooks",
        issue_events_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/events{/number}",
        events_url:
          "https://api.github.com/repos/Codertocat/Hello-World/events",
        assignees_url:
          "https://api.github.com/repos/Codertocat/Hello-World/assignees{/user}",
        branches_url:
          "https://api.github.com/repos/Codertocat/Hello-World/branches{/branch}",
        tags_url: "https://api.github.com/repos/Codertocat/Hello-World/tags",
        blobs_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/blobs{/sha}",
        git_tags_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/tags{/sha}",
        git_refs_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/refs{/sha}",
        trees_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/trees{/sha}",
        statuses_url:
          "https://api.github.com/repos/Codertocat/Hello-World/statuses/{sha}",
        languages_url:
          "https://api.github.com/repos/Codertocat/Hello-World/languages",
        stargazers_url:
          "https://api.github.com/repos/Codertocat/Hello-World/stargazers",
        contributors_url:
          "https://api.github.com/repos/Codertocat/Hello-World/contributors",
        subscribers_url:
          "https://api.github.com/repos/Codertocat/Hello-World/subscribers",
        subscription_url:
          "https://api.github.com/repos/Codertocat/Hello-World/subscription",
        commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/commits{/sha}",
        git_commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/commits{/sha}",
        comments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/comments{/number}",
        issue_comment_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/comments{/number}",
        contents_url:
          "https://api.github.com/repos/Codertocat/Hello-World/contents/{+path}",
        compare_url:
          "https://api.github.com/repos/Codertocat/Hello-World/compare/{base}...{head}",
        merges_url:
          "https://api.github.com/repos/Codertocat/Hello-World/merges",
        archive_url:
          "https://api.github.com/repos/Codertocat/Hello-World/{archive_format}{/ref}",
        downloads_url:
          "https://api.github.com/repos/Codertocat/Hello-World/downloads",
        issues_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues{/number}",
        pulls_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls{/number}",
        milestones_url:
          "https://api.github.com/repos/Codertocat/Hello-World/milestones{/number}",
        notifications_url:
          "https://api.github.com/repos/Codertocat/Hello-World/notifications{?since,all,participating}",
        labels_url:
          "https://api.github.com/repos/Codertocat/Hello-World/labels{/name}",
        releases_url:
          "https://api.github.com/repos/Codertocat/Hello-World/releases{/id}",
        deployments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/deployments",
        created_at: "2019-05-15T15:19:25Z",
        updated_at: "2019-05-15T15:19:27Z",
        pushed_at: "2019-05-15T15:20:13Z",
        git_url: "git://github.com/Codertocat/Hello-World.git",
        ssh_url: "git@github.com:Codertocat/Hello-World.git",
        clone_url: "https://github.com/Codertocat/Hello-World.git",
        svn_url: "https://github.com/Codertocat/Hello-World",
        homepage: null,
        size: 0,
        stargazers_count: 0,
        watchers_count: 0,
        language: null,
        has_issues: true,
        has_projects: true,
        has_downloads: true,
        has_wiki: true,
        has_pages: true,
        forks_count: 0,
        mirror_url: null,
        archived: false,
        disabled: false,
        open_issues_count: 1,
        license: null,
        forks: 0,
        open_issues: 1,
        watchers: 0,
        default_branch: "master",
      },
      sender: {
        login: "Codertocat",
        id: 21031067,
        node_id: "MDQ6VXNlcjIxMDMxMDY3",
        avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
        gravatar_id: "",
        url: "https://api.github.com/users/Codertocat",
        html_url: "https://github.com/Codertocat",
        followers_url: "https://api.github.com/users/Codertocat/followers",
        following_url:
          "https://api.github.com/users/Codertocat/following{/other_user}",
        gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
        starred_url:
          "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
        subscriptions_url:
          "https://api.github.com/users/Codertocat/subscriptions",
        organizations_url: "https://api.github.com/users/Codertocat/orgs",
        repos_url: "https://api.github.com/users/Codertocat/repos",
        events_url: "https://api.github.com/users/Codertocat/events{/privacy}",
        received_events_url:
          "https://api.github.com/users/Codertocat/received_events",
        type: "User",
        site_admin: false,
      },
    },
  },
  issue_comment: {
    name: "A comment on an issue or pull request is created",
    payload: {
      action: "created",
      issue: {
        url: "https://api.github.com/repos/Codertocat/Hello-World/issues/1",
        repository_url: "https://api.github.com/repos/Codertocat/Hello-World",
        labels_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/1/labels{/name}",
        comments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/1/comments",
        events_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/1/events",
        html_url: "https://github.com/Codertocat/Hello-World/issues/1",
        id: 444500041,
        node_id: "MDU6SXNzdWU0NDQ1MDAwNDE=",
        number: 1,
        title: "Spelling error in the README file",
        user: {
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        labels: [
          {
            id: 1362934389,
            node_id: "MDU6TGFiZWwxMzYyOTM0Mzg5",
            url: "https://api.github.com/repos/Codertocat/Hello-World/labels/bug",
            name: "bug",
            color: "d73a4a",
            default: true,
          },
        ],
        state: "open",
        locked: false,
        assignee: {
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        assignees: [
          {
            login: "Codertocat",
            id: 21031067,
            node_id: "MDQ6VXNlcjIxMDMxMDY3",
            avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
            gravatar_id: "",
            url: "https://api.github.com/users/Codertocat",
            html_url: "https://github.com/Codertocat",
            followers_url: "https://api.github.com/users/Codertocat/followers",
            following_url:
              "https://api.github.com/users/Codertocat/following{/other_user}",
            gists_url:
              "https://api.github.com/users/Codertocat/gists{/gist_id}",
            starred_url:
              "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
            subscriptions_url:
              "https://api.github.com/users/Codertocat/subscriptions",
            organizations_url: "https://api.github.com/users/Codertocat/orgs",
            repos_url: "https://api.github.com/users/Codertocat/repos",
            events_url:
              "https://api.github.com/users/Codertocat/events{/privacy}",
            received_events_url:
              "https://api.github.com/users/Codertocat/received_events",
            type: "User",
            site_admin: false,
          },
        ],
        milestone: {
          url: "https://api.github.com/repos/Codertocat/Hello-World/milestones/1",
          html_url: "https://github.com/Codertocat/Hello-World/milestone/1",
          labels_url:
            "https://api.github.com/repos/Codertocat/Hello-World/milestones/1/labels",
          id: 4317517,
          node_id: "MDk6TWlsZXN0b25lNDMxNzUxNw==",
          number: 1,
          title: "v1.0",
          description: "Add new space flight simulator",
          creator: {
            login: "Codertocat",
            id: 21031067,
            node_id: "MDQ6VXNlcjIxMDMxMDY3",
            avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
            gravatar_id: "",
            url: "https://api.github.com/users/Codertocat",
            html_url: "https://github.com/Codertocat",
            followers_url: "https://api.github.com/users/Codertocat/followers",
            following_url:
              "https://api.github.com/users/Codertocat/following{/other_user}",
            gists_url:
              "https://api.github.com/users/Codertocat/gists{/gist_id}",
            starred_url:
              "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
            subscriptions_url:
              "https://api.github.com/users/Codertocat/subscriptions",
            organizations_url: "https://api.github.com/users/Codertocat/orgs",
            repos_url: "https://api.github.com/users/Codertocat/repos",
            events_url:
              "https://api.github.com/users/Codertocat/events{/privacy}",
            received_events_url:
              "https://api.github.com/users/Codertocat/received_events",
            type: "User",
            site_admin: false,
          },
          open_issues: 1,
          closed_issues: 0,
          state: "closed",
          created_at: "2019-05-15T15:20:17Z",
          updated_at: "2019-05-15T15:20:18Z",
          due_on: "2019-05-23T07:00:00Z",
          closed_at: "2019-05-15T15:20:18Z",
        },
        comments: 0,
        created_at: "2019-05-15T15:20:18Z",
        updated_at: "2019-05-15T15:20:21Z",
        closed_at: null,
        author_association: "OWNER",
        body: "It looks like you accidently spelled 'commit' with two 't's.",
      },
      comment: {
        url: "https://api.github.com/repos/Codertocat/Hello-World/issues/comments/492700400",
        html_url:
          "https://github.com/Codertocat/Hello-World/issues/1#issuecomment-492700400",
        issue_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/1",
        id: 492700400,
        node_id: "MDEyOklzc3VlQ29tbWVudDQ5MjcwMDQwMA==",
        user: {
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        created_at: "2019-05-15T15:20:21Z",
        updated_at: "2019-05-15T15:20:21Z",
        author_association: "OWNER",
        body: "You are totally right! I'll get this fixed right away.",
      },
      repository: {
        id: 186853002,
        node_id: "MDEwOlJlcG9zaXRvcnkxODY4NTMwMDI=",
        name: "Hello-World",
        full_name: "Codertocat/Hello-World",
        private: false,
        owner: {
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        html_url: "https://github.com/Codertocat/Hello-World",
        description: null,
        fork: false,
        url: "https://api.github.com/repos/Codertocat/Hello-World",
        forks_url: "https://api.github.com/repos/Codertocat/Hello-World/forks",
        keys_url:
          "https://api.github.com/repos/Codertocat/Hello-World/keys{/key_id}",
        collaborators_url:
          "https://api.github.com/repos/Codertocat/Hello-World/collaborators{/collaborator}",
        teams_url: "https://api.github.com/repos/Codertocat/Hello-World/teams",
        hooks_url: "https://api.github.com/repos/Codertocat/Hello-World/hooks",
        issue_events_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/events{/number}",
        events_url:
          "https://api.github.com/repos/Codertocat/Hello-World/events",
        assignees_url:
          "https://api.github.com/repos/Codertocat/Hello-World/assignees{/user}",
        branches_url:
          "https://api.github.com/repos/Codertocat/Hello-World/branches{/branch}",
        tags_url: "https://api.github.com/repos/Codertocat/Hello-World/tags",
        blobs_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/blobs{/sha}",
        git_tags_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/tags{/sha}",
        git_refs_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/refs{/sha}",
        trees_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/trees{/sha}",
        statuses_url:
          "https://api.github.com/repos/Codertocat/Hello-World/statuses/{sha}",
        languages_url:
          "https://api.github.com/repos/Codertocat/Hello-World/languages",
        stargazers_url:
          "https://api.github.com/repos/Codertocat/Hello-World/stargazers",
        contributors_url:
          "https://api.github.com/repos/Codertocat/Hello-World/contributors",
        subscribers_url:
          "https://api.github.com/repos/Codertocat/Hello-World/subscribers",
        subscription_url:
          "https://api.github.com/repos/Codertocat/Hello-World/subscription",
        commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/commits{/sha}",
        git_commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/commits{/sha}",
        comments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/comments{/number}",
        issue_comment_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/comments{/number}",
        contents_url:
          "https://api.github.com/repos/Codertocat/Hello-World/contents/{+path}",
        compare_url:
          "https://api.github.com/repos/Codertocat/Hello-World/compare/{base}...{head}",
        merges_url:
          "https://api.github.com/repos/Codertocat/Hello-World/merges",
        archive_url:
          "https://api.github.com/repos/Codertocat/Hello-World/{archive_format}{/ref}",
        downloads_url:
          "https://api.github.com/repos/Codertocat/Hello-World/downloads",
        issues_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues{/number}",
        pulls_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls{/number}",
        milestones_url:
          "https://api.github.com/repos/Codertocat/Hello-World/milestones{/number}",
        notifications_url:
          "https://api.github.com/repos/Codertocat/Hello-World/notifications{?since,all,participating}",
        labels_url:
          "https://api.github.com/repos/Codertocat/Hello-World/labels{/name}",
        releases_url:
          "https://api.github.com/repos/Codertocat/Hello-World/releases{/id}",
        deployments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/deployments",
        created_at: "2019-05-15T15:19:25Z",
        updated_at: "2019-05-15T15:19:27Z",
        pushed_at: "2019-05-15T15:20:13Z",
        git_url: "git://github.com/Codertocat/Hello-World.git",
        ssh_url: "git@github.com:Codertocat/Hello-World.git",
        clone_url: "https://github.com/Codertocat/Hello-World.git",
        svn_url: "https://github.com/Codertocat/Hello-World",
        homepage: null,
        size: 0,
        stargazers_count: 0,
        watchers_count: 0,
        language: null,
        has_issues: true,
        has_projects: true,
        has_downloads: true,
        has_wiki: true,
        has_pages: true,
        forks_count: 0,
        mirror_url: null,
        archived: false,
        disabled: false,
        open_issues_count: 1,
        license: null,
        forks: 0,
        open_issues: 1,
        watchers: 0,
        default_branch: "master",
      },
      sender: {
        login: "Codertocat",
        id: 21031067,
        node_id: "MDQ6VXNlcjIxMDMxMDY3",
        avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
        gravatar_id: "",
        url: "https://api.github.com/users/Codertocat",
        html_url: "https://github.com/Codertocat",
        followers_url: "https://api.github.com/users/Codertocat/followers",
        following_url:
          "https://api.github.com/users/Codertocat/following{/other_user}",
        gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
        starred_url:
          "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
        subscriptions_url:
          "https://api.github.com/users/Codertocat/subscriptions",
        organizations_url: "https://api.github.com/users/Codertocat/orgs",
        repos_url: "https://api.github.com/users/Codertocat/repos",
        events_url: "https://api.github.com/users/Codertocat/events{/privacy}",
        received_events_url:
          "https://api.github.com/users/Codertocat/received_events",
        type: "User",
        site_admin: false,
      },
    },
  },
  pull_request: {
    name: "A pull request was opened",
    payload: {
      action: "opened",
      number: 2,
      pull_request: {
        url: "https://api.github.com/repos/Codertocat/Hello-World/pulls/2",
        id: 279147437,
        node_id: "MDExOlB1bGxSZXF1ZXN0Mjc5MTQ3NDM3",
        html_url: "https://github.com/Codertocat/Hello-World/pull/2",
        diff_url: "https://github.com/Codertocat/Hello-World/pull/2.diff",
        patch_url: "https://github.com/Codertocat/Hello-World/pull/2.patch",
        issue_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/2",
        number: 2,
        state: "open",
        locked: false,
        title: "Update the README with new information.",
        user: {
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        body: "This is a pretty simple change that we need to pull into master.",
        created_at: "2019-05-15T15:20:33Z",
        updated_at: "2019-05-15T15:20:33Z",
        closed_at: null,
        merged_at: null,
        merge_commit_sha: null,
        assignee: null,
        assignees: [],
        requested_reviewers: [],
        requested_teams: [],
        labels: [],
        milestone: null,
        commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls/2/commits",
        review_comments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls/2/comments",
        review_comment_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls/comments{/number}",
        comments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/2/comments",
        statuses_url:
          "https://api.github.com/repos/Codertocat/Hello-World/statuses/ec26c3e57ca3a959ca5aad62de7213c562f8c821",
        head: {
          label: "Codertocat:changes",
          ref: "changes",
          sha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
          user: {
            login: "Codertocat",
            id: 21031067,
            node_id: "MDQ6VXNlcjIxMDMxMDY3",
            avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
            gravatar_id: "",
            url: "https://api.github.com/users/Codertocat",
            html_url: "https://github.com/Codertocat",
            followers_url: "https://api.github.com/users/Codertocat/followers",
            following_url:
              "https://api.github.com/users/Codertocat/following{/other_user}",
            gists_url:
              "https://api.github.com/users/Codertocat/gists{/gist_id}",
            starred_url:
              "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
            subscriptions_url:
              "https://api.github.com/users/Codertocat/subscriptions",
            organizations_url: "https://api.github.com/users/Codertocat/orgs",
            repos_url: "https://api.github.com/users/Codertocat/repos",
            events_url:
              "https://api.github.com/users/Codertocat/events{/privacy}",
            received_events_url:
              "https://api.github.com/users/Codertocat/received_events",
            type: "User",
            site_admin: false,
          },
          repo: {
            id: 186853002,
            node_id: "MDEwOlJlcG9zaXRvcnkxODY4NTMwMDI=",
            name: "Hello-World",
            full_name: "Codertocat/Hello-World",
            private: false,
            owner: {
              login: "Codertocat",
              id: 21031067,
              node_id: "MDQ6VXNlcjIxMDMxMDY3",
              avatar_url:
                "https://avatars1.githubusercontent.com/u/21031067?v=4",
              gravatar_id: "",
              url: "https://api.github.com/users/Codertocat",
              html_url: "https://github.com/Codertocat",
              followers_url:
                "https://api.github.com/users/Codertocat/followers",
              following_url:
                "https://api.github.com/users/Codertocat/following{/other_user}",
              gists_url:
                "https://api.github.com/users/Codertocat/gists{/gist_id}",
              starred_url:
                "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
              subscriptions_url:
                "https://api.github.com/users/Codertocat/subscriptions",
              organizations_url: "https://api.github.com/users/Codertocat/orgs",
              repos_url: "https://api.github.com/users/Codertocat/repos",
              events_url:
                "https://api.github.com/users/Codertocat/events{/privacy}",
              received_events_url:
                "https://api.github.com/users/Codertocat/received_events",
              type: "User",
              site_admin: false,
            },
            html_url: "https://github.com/Codertocat/Hello-World",
            description: null,
            fork: false,
            url: "https://api.github.com/repos/Codertocat/Hello-World",
            forks_url:
              "https://api.github.com/repos/Codertocat/Hello-World/forks",
            keys_url:
              "https://api.github.com/repos/Codertocat/Hello-World/keys{/key_id}",
            collaborators_url:
              "https://api.github.com/repos/Codertocat/Hello-World/collaborators{/collaborator}",
            teams_url:
              "https://api.github.com/repos/Codertocat/Hello-World/teams",
            hooks_url:
              "https://api.github.com/repos/Codertocat/Hello-World/hooks",
            issue_events_url:
              "https://api.github.com/repos/Codertocat/Hello-World/issues/events{/number}",
            events_url:
              "https://api.github.com/repos/Codertocat/Hello-World/events",
            assignees_url:
              "https://api.github.com/repos/Codertocat/Hello-World/assignees{/user}",
            branches_url:
              "https://api.github.com/repos/Codertocat/Hello-World/branches{/branch}",
            tags_url:
              "https://api.github.com/repos/Codertocat/Hello-World/tags",
            blobs_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/blobs{/sha}",
            git_tags_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/tags{/sha}",
            git_refs_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/refs{/sha}",
            trees_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/trees{/sha}",
            statuses_url:
              "https://api.github.com/repos/Codertocat/Hello-World/statuses/{sha}",
            languages_url:
              "https://api.github.com/repos/Codertocat/Hello-World/languages",
            stargazers_url:
              "https://api.github.com/repos/Codertocat/Hello-World/stargazers",
            contributors_url:
              "https://api.github.com/repos/Codertocat/Hello-World/contributors",
            subscribers_url:
              "https://api.github.com/repos/Codertocat/Hello-World/subscribers",
            subscription_url:
              "https://api.github.com/repos/Codertocat/Hello-World/subscription",
            commits_url:
              "https://api.github.com/repos/Codertocat/Hello-World/commits{/sha}",
            git_commits_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/commits{/sha}",
            comments_url:
              "https://api.github.com/repos/Codertocat/Hello-World/comments{/number}",
            issue_comment_url:
              "https://api.github.com/repos/Codertocat/Hello-World/issues/comments{/number}",
            contents_url:
              "https://api.github.com/repos/Codertocat/Hello-World/contents/{+path}",
            compare_url:
              "https://api.github.com/repos/Codertocat/Hello-World/compare/{base}...{head}",
            merges_url:
              "https://api.github.com/repos/Codertocat/Hello-World/merges",
            archive_url:
              "https://api.github.com/repos/Codertocat/Hello-World/{archive_format}{/ref}",
            downloads_url:
              "https://api.github.com/repos/Codertocat/Hello-World/downloads",
            issues_url:
              "https://api.github.com/repos/Codertocat/Hello-World/issues{/number}",
            pulls_url:
              "https://api.github.com/repos/Codertocat/Hello-World/pulls{/number}",
            milestones_url:
              "https://api.github.com/repos/Codertocat/Hello-World/milestones{/number}",
            notifications_url:
              "https://api.github.com/repos/Codertocat/Hello-World/notifications{?since,all,participating}",
            labels_url:
              "https://api.github.com/repos/Codertocat/Hello-World/labels{/name}",
            releases_url:
              "https://api.github.com/repos/Codertocat/Hello-World/releases{/id}",
            deployments_url:
              "https://api.github.com/repos/Codertocat/Hello-World/deployments",
            created_at: "2019-05-15T15:19:25Z",
            updated_at: "2019-05-15T15:19:27Z",
            pushed_at: "2019-05-15T15:20:32Z",
            git_url: "git://github.com/Codertocat/Hello-World.git",
            ssh_url: "git@github.com:Codertocat/Hello-World.git",
            clone_url: "https://github.com/Codertocat/Hello-World.git",
            svn_url: "https://github.com/Codertocat/Hello-World",
            homepage: null,
            size: 0,
            stargazers_count: 0,
            watchers_count: 0,
            language: null,
            has_issues: true,
            has_projects: true,
            has_downloads: true,
            has_wiki: true,
            has_pages: true,
            forks_count: 0,
            mirror_url: null,
            archived: false,
            disabled: false,
            open_issues_count: 2,
            license: null,
            forks: 0,
            open_issues: 2,
            watchers: 0,
            default_branch: "master",
            allow_squash_merge: true,
            allow_merge_commit: true,
            allow_rebase_merge: true,
            delete_branch_on_merge: false,
          },
        },
        base: {
          label: "Codertocat:master",
          ref: "master",
          sha: "f95f852bd8fca8fcc58a9a2d6c842781e32a215e",
          user: {
            login: "Codertocat",
            id: 21031067,
            node_id: "MDQ6VXNlcjIxMDMxMDY3",
            avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
            gravatar_id: "",
            url: "https://api.github.com/users/Codertocat",
            html_url: "https://github.com/Codertocat",
            followers_url: "https://api.github.com/users/Codertocat/followers",
            following_url:
              "https://api.github.com/users/Codertocat/following{/other_user}",
            gists_url:
              "https://api.github.com/users/Codertocat/gists{/gist_id}",
            starred_url:
              "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
            subscriptions_url:
              "https://api.github.com/users/Codertocat/subscriptions",
            organizations_url: "https://api.github.com/users/Codertocat/orgs",
            repos_url: "https://api.github.com/users/Codertocat/repos",
            events_url:
              "https://api.github.com/users/Codertocat/events{/privacy}",
            received_events_url:
              "https://api.github.com/users/Codertocat/received_events",
            type: "User",
            site_admin: false,
          },
          repo: {
            id: 186853002,
            node_id: "MDEwOlJlcG9zaXRvcnkxODY4NTMwMDI=",
            name: "Hello-World",
            full_name: "Codertocat/Hello-World",
            private: false,
            owner: {
              login: "Codertocat",
              id: 21031067,
              node_id: "MDQ6VXNlcjIxMDMxMDY3",
              avatar_url:
                "https://avatars1.githubusercontent.com/u/21031067?v=4",
              gravatar_id: "",
              url: "https://api.github.com/users/Codertocat",
              html_url: "https://github.com/Codertocat",
              followers_url:
                "https://api.github.com/users/Codertocat/followers",
              following_url:
                "https://api.github.com/users/Codertocat/following{/other_user}",
              gists_url:
                "https://api.github.com/users/Codertocat/gists{/gist_id}",
              starred_url:
                "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
              subscriptions_url:
                "https://api.github.com/users/Codertocat/subscriptions",
              organizations_url: "https://api.github.com/users/Codertocat/orgs",
              repos_url: "https://api.github.com/users/Codertocat/repos",
              events_url:
                "https://api.github.com/users/Codertocat/events{/privacy}",
              received_events_url:
                "https://api.github.com/users/Codertocat/received_events",
              type: "User",
              site_admin: false,
            },
            html_url: "https://github.com/Codertocat/Hello-World",
            description: null,
            fork: false,
            url: "https://api.github.com/repos/Codertocat/Hello-World",
            forks_url:
              "https://api.github.com/repos/Codertocat/Hello-World/forks",
            keys_url:
              "https://api.github.com/repos/Codertocat/Hello-World/keys{/key_id}",
            collaborators_url:
              "https://api.github.com/repos/Codertocat/Hello-World/collaborators{/collaborator}",
            teams_url:
              "https://api.github.com/repos/Codertocat/Hello-World/teams",
            hooks_url:
              "https://api.github.com/repos/Codertocat/Hello-World/hooks",
            issue_events_url:
              "https://api.github.com/repos/Codertocat/Hello-World/issues/events{/number}",
            events_url:
              "https://api.github.com/repos/Codertocat/Hello-World/events",
            assignees_url:
              "https://api.github.com/repos/Codertocat/Hello-World/assignees{/user}",
            branches_url:
              "https://api.github.com/repos/Codertocat/Hello-World/branches{/branch}",
            tags_url:
              "https://api.github.com/repos/Codertocat/Hello-World/tags",
            blobs_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/blobs{/sha}",
            git_tags_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/tags{/sha}",
            git_refs_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/refs{/sha}",
            trees_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/trees{/sha}",
            statuses_url:
              "https://api.github.com/repos/Codertocat/Hello-World/statuses/{sha}",
            languages_url:
              "https://api.github.com/repos/Codertocat/Hello-World/languages",
            stargazers_url:
              "https://api.github.com/repos/Codertocat/Hello-World/stargazers",
            contributors_url:
              "https://api.github.com/repos/Codertocat/Hello-World/contributors",
            subscribers_url:
              "https://api.github.com/repos/Codertocat/Hello-World/subscribers",
            subscription_url:
              "https://api.github.com/repos/Codertocat/Hello-World/subscription",
            commits_url:
              "https://api.github.com/repos/Codertocat/Hello-World/commits{/sha}",
            git_commits_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/commits{/sha}",
            comments_url:
              "https://api.github.com/repos/Codertocat/Hello-World/comments{/number}",
            issue_comment_url:
              "https://api.github.com/repos/Codertocat/Hello-World/issues/comments{/number}",
            contents_url:
              "https://api.github.com/repos/Codertocat/Hello-World/contents/{+path}",
            compare_url:
              "https://api.github.com/repos/Codertocat/Hello-World/compare/{base}...{head}",
            merges_url:
              "https://api.github.com/repos/Codertocat/Hello-World/merges",
            archive_url:
              "https://api.github.com/repos/Codertocat/Hello-World/{archive_format}{/ref}",
            downloads_url:
              "https://api.github.com/repos/Codertocat/Hello-World/downloads",
            issues_url:
              "https://api.github.com/repos/Codertocat/Hello-World/issues{/number}",
            pulls_url:
              "https://api.github.com/repos/Codertocat/Hello-World/pulls{/number}",
            milestones_url:
              "https://api.github.com/repos/Codertocat/Hello-World/milestones{/number}",
            notifications_url:
              "https://api.github.com/repos/Codertocat/Hello-World/notifications{?since,all,participating}",
            labels_url:
              "https://api.github.com/repos/Codertocat/Hello-World/labels{/name}",
            releases_url:
              "https://api.github.com/repos/Codertocat/Hello-World/releases{/id}",
            deployments_url:
              "https://api.github.com/repos/Codertocat/Hello-World/deployments",
            created_at: "2019-05-15T15:19:25Z",
            updated_at: "2019-05-15T15:19:27Z",
            pushed_at: "2019-05-15T15:20:32Z",
            git_url: "git://github.com/Codertocat/Hello-World.git",
            ssh_url: "git@github.com:Codertocat/Hello-World.git",
            clone_url: "https://github.com/Codertocat/Hello-World.git",
            svn_url: "https://github.com/Codertocat/Hello-World",
            homepage: null,
            size: 0,
            stargazers_count: 0,
            watchers_count: 0,
            language: null,
            has_issues: true,
            has_projects: true,
            has_downloads: true,
            has_wiki: true,
            has_pages: true,
            forks_count: 0,
            mirror_url: null,
            archived: false,
            disabled: false,
            open_issues_count: 2,
            license: null,
            forks: 0,
            open_issues: 2,
            watchers: 0,
            default_branch: "master",
            allow_squash_merge: true,
            allow_merge_commit: true,
            allow_rebase_merge: true,
            delete_branch_on_merge: false,
          },
        },
        _links: {
          self: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/pulls/2",
          },
          html: {
            href: "https://github.com/Codertocat/Hello-World/pull/2",
          },
          issue: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/issues/2",
          },
          comments: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/issues/2/comments",
          },
          review_comments: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/pulls/2/comments",
          },
          review_comment: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/pulls/comments{/number}",
          },
          commits: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/pulls/2/commits",
          },
          statuses: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/statuses/ec26c3e57ca3a959ca5aad62de7213c562f8c821",
          },
        },
        author_association: "OWNER",
        draft: false,
        merged: false,
        mergeable: null,
        rebaseable: null,
        mergeable_state: "unknown",
        merged_by: null,
        comments: 0,
        review_comments: 0,
        maintainer_can_modify: false,
        commits: 1,
        additions: 1,
        deletions: 1,
        changed_files: 1,
      },
      repository: {
        id: 186853002,
        node_id: "MDEwOlJlcG9zaXRvcnkxODY4NTMwMDI=",
        name: "Hello-World",
        full_name: "Codertocat/Hello-World",
        private: false,
        owner: {
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        html_url: "https://github.com/Codertocat/Hello-World",
        description: null,
        fork: false,
        url: "https://api.github.com/repos/Codertocat/Hello-World",
        forks_url: "https://api.github.com/repos/Codertocat/Hello-World/forks",
        keys_url:
          "https://api.github.com/repos/Codertocat/Hello-World/keys{/key_id}",
        collaborators_url:
          "https://api.github.com/repos/Codertocat/Hello-World/collaborators{/collaborator}",
        teams_url: "https://api.github.com/repos/Codertocat/Hello-World/teams",
        hooks_url: "https://api.github.com/repos/Codertocat/Hello-World/hooks",
        issue_events_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/events{/number}",
        events_url:
          "https://api.github.com/repos/Codertocat/Hello-World/events",
        assignees_url:
          "https://api.github.com/repos/Codertocat/Hello-World/assignees{/user}",
        branches_url:
          "https://api.github.com/repos/Codertocat/Hello-World/branches{/branch}",
        tags_url: "https://api.github.com/repos/Codertocat/Hello-World/tags",
        blobs_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/blobs{/sha}",
        git_tags_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/tags{/sha}",
        git_refs_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/refs{/sha}",
        trees_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/trees{/sha}",
        statuses_url:
          "https://api.github.com/repos/Codertocat/Hello-World/statuses/{sha}",
        languages_url:
          "https://api.github.com/repos/Codertocat/Hello-World/languages",
        stargazers_url:
          "https://api.github.com/repos/Codertocat/Hello-World/stargazers",
        contributors_url:
          "https://api.github.com/repos/Codertocat/Hello-World/contributors",
        subscribers_url:
          "https://api.github.com/repos/Codertocat/Hello-World/subscribers",
        subscription_url:
          "https://api.github.com/repos/Codertocat/Hello-World/subscription",
        commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/commits{/sha}",
        git_commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/commits{/sha}",
        comments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/comments{/number}",
        issue_comment_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/comments{/number}",
        contents_url:
          "https://api.github.com/repos/Codertocat/Hello-World/contents/{+path}",
        compare_url:
          "https://api.github.com/repos/Codertocat/Hello-World/compare/{base}...{head}",
        merges_url:
          "https://api.github.com/repos/Codertocat/Hello-World/merges",
        archive_url:
          "https://api.github.com/repos/Codertocat/Hello-World/{archive_format}{/ref}",
        downloads_url:
          "https://api.github.com/repos/Codertocat/Hello-World/downloads",
        issues_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues{/number}",
        pulls_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls{/number}",
        milestones_url:
          "https://api.github.com/repos/Codertocat/Hello-World/milestones{/number}",
        notifications_url:
          "https://api.github.com/repos/Codertocat/Hello-World/notifications{?since,all,participating}",
        labels_url:
          "https://api.github.com/repos/Codertocat/Hello-World/labels{/name}",
        releases_url:
          "https://api.github.com/repos/Codertocat/Hello-World/releases{/id}",
        deployments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/deployments",
        created_at: "2019-05-15T15:19:25Z",
        updated_at: "2019-05-15T15:19:27Z",
        pushed_at: "2019-05-15T15:20:32Z",
        git_url: "git://github.com/Codertocat/Hello-World.git",
        ssh_url: "git@github.com:Codertocat/Hello-World.git",
        clone_url: "https://github.com/Codertocat/Hello-World.git",
        svn_url: "https://github.com/Codertocat/Hello-World",
        homepage: null,
        size: 0,
        stargazers_count: 0,
        watchers_count: 0,
        language: null,
        has_issues: true,
        has_projects: true,
        has_downloads: true,
        has_wiki: true,
        has_pages: true,
        forks_count: 0,
        mirror_url: null,
        archived: false,
        disabled: false,
        open_issues_count: 2,
        license: null,
        forks: 0,
        open_issues: 2,
        watchers: 0,
        default_branch: "master",
      },
      sender: {
        login: "Codertocat",
        id: 21031067,
        node_id: "MDQ6VXNlcjIxMDMxMDY3",
        avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
        gravatar_id: "",
        url: "https://api.github.com/users/Codertocat",
        html_url: "https://github.com/Codertocat",
        followers_url: "https://api.github.com/users/Codertocat/followers",
        following_url:
          "https://api.github.com/users/Codertocat/following{/other_user}",
        gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
        starred_url:
          "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
        subscriptions_url:
          "https://api.github.com/users/Codertocat/subscriptions",
        organizations_url: "https://api.github.com/users/Codertocat/orgs",
        repos_url: "https://api.github.com/users/Codertocat/repos",
        events_url: "https://api.github.com/users/Codertocat/events{/privacy}",
        received_events_url:
          "https://api.github.com/users/Codertocat/received_events",
        type: "User",
        site_admin: false,
      },
    },
  },
  pull_request_review_comment: {
    name: "A comment was added to a pull request's unified diff",
    payload: {
      action: "created",
      comment: {
        url: "https://api.github.com/repos/Codertocat/Hello-World/pulls/comments/284312630",
        pull_request_review_id: 237895671,
        id: 284312630,
        node_id: "MDI0OlB1bGxSZXF1ZXN0UmV2aWV3Q29tbWVudDI4NDMxMjYzMA==",
        diff_hunk: "@@ -1 +1 @@\n-# Hello-World",
        path: "README.md",
        position: 1,
        original_position: 1,
        commit_id: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
        original_commit_id: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
        user: {
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        body: "Maybe you should use more emoji on this line.",
        created_at: "2019-05-15T15:20:37Z",
        updated_at: "2019-05-15T15:20:38Z",
        html_url:
          "https://github.com/Codertocat/Hello-World/pull/2#discussion_r284312630",
        pull_request_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls/2",
        author_association: "OWNER",
        _links: {
          self: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/pulls/comments/284312630",
          },
          html: {
            href: "https://github.com/Codertocat/Hello-World/pull/2#discussion_r284312630",
          },
          pull_request: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/pulls/2",
          },
        },
      },
      pull_request: {
        url: "https://api.github.com/repos/Codertocat/Hello-World/pulls/2",
        id: 279147437,
        node_id: "MDExOlB1bGxSZXF1ZXN0Mjc5MTQ3NDM3",
        html_url: "https://github.com/Codertocat/Hello-World/pull/2",
        diff_url: "https://github.com/Codertocat/Hello-World/pull/2.diff",
        patch_url: "https://github.com/Codertocat/Hello-World/pull/2.patch",
        issue_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/2",
        number: 2,
        state: "open",
        locked: false,
        title: "Update the README with new information.",
        user: {
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        body: "This is a pretty simple change that we need to pull into master.",
        created_at: "2019-05-15T15:20:33Z",
        updated_at: "2019-05-15T15:20:38Z",
        closed_at: null,
        merged_at: null,
        merge_commit_sha: "c4295bd74fb0f4fda03689c3df3f2803b658fd85",
        assignee: null,
        assignees: [],
        requested_reviewers: [],
        requested_teams: [],
        labels: [],
        milestone: null,
        commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls/2/commits",
        review_comments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls/2/comments",
        review_comment_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls/comments{/number}",
        comments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/2/comments",
        statuses_url:
          "https://api.github.com/repos/Codertocat/Hello-World/statuses/ec26c3e57ca3a959ca5aad62de7213c562f8c821",
        head: {
          label: "Codertocat:changes",
          ref: "changes",
          sha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
          user: {
            login: "Codertocat",
            id: 21031067,
            node_id: "MDQ6VXNlcjIxMDMxMDY3",
            avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
            gravatar_id: "",
            url: "https://api.github.com/users/Codertocat",
            html_url: "https://github.com/Codertocat",
            followers_url: "https://api.github.com/users/Codertocat/followers",
            following_url:
              "https://api.github.com/users/Codertocat/following{/other_user}",
            gists_url:
              "https://api.github.com/users/Codertocat/gists{/gist_id}",
            starred_url:
              "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
            subscriptions_url:
              "https://api.github.com/users/Codertocat/subscriptions",
            organizations_url: "https://api.github.com/users/Codertocat/orgs",
            repos_url: "https://api.github.com/users/Codertocat/repos",
            events_url:
              "https://api.github.com/users/Codertocat/events{/privacy}",
            received_events_url:
              "https://api.github.com/users/Codertocat/received_events",
            type: "User",
            site_admin: false,
          },
          repo: {
            id: 186853002,
            node_id: "MDEwOlJlcG9zaXRvcnkxODY4NTMwMDI=",
            name: "Hello-World",
            full_name: "Codertocat/Hello-World",
            private: false,
            owner: {
              login: "Codertocat",
              id: 21031067,
              node_id: "MDQ6VXNlcjIxMDMxMDY3",
              avatar_url:
                "https://avatars1.githubusercontent.com/u/21031067?v=4",
              gravatar_id: "",
              url: "https://api.github.com/users/Codertocat",
              html_url: "https://github.com/Codertocat",
              followers_url:
                "https://api.github.com/users/Codertocat/followers",
              following_url:
                "https://api.github.com/users/Codertocat/following{/other_user}",
              gists_url:
                "https://api.github.com/users/Codertocat/gists{/gist_id}",
              starred_url:
                "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
              subscriptions_url:
                "https://api.github.com/users/Codertocat/subscriptions",
              organizations_url: "https://api.github.com/users/Codertocat/orgs",
              repos_url: "https://api.github.com/users/Codertocat/repos",
              events_url:
                "https://api.github.com/users/Codertocat/events{/privacy}",
              received_events_url:
                "https://api.github.com/users/Codertocat/received_events",
              type: "User",
              site_admin: false,
            },
            html_url: "https://github.com/Codertocat/Hello-World",
            description: null,
            fork: false,
            url: "https://api.github.com/repos/Codertocat/Hello-World",
            forks_url:
              "https://api.github.com/repos/Codertocat/Hello-World/forks",
            keys_url:
              "https://api.github.com/repos/Codertocat/Hello-World/keys{/key_id}",
            collaborators_url:
              "https://api.github.com/repos/Codertocat/Hello-World/collaborators{/collaborator}",
            teams_url:
              "https://api.github.com/repos/Codertocat/Hello-World/teams",
            hooks_url:
              "https://api.github.com/repos/Codertocat/Hello-World/hooks",
            issue_events_url:
              "https://api.github.com/repos/Codertocat/Hello-World/issues/events{/number}",
            events_url:
              "https://api.github.com/repos/Codertocat/Hello-World/events",
            assignees_url:
              "https://api.github.com/repos/Codertocat/Hello-World/assignees{/user}",
            branches_url:
              "https://api.github.com/repos/Codertocat/Hello-World/branches{/branch}",
            tags_url:
              "https://api.github.com/repos/Codertocat/Hello-World/tags",
            blobs_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/blobs{/sha}",
            git_tags_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/tags{/sha}",
            git_refs_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/refs{/sha}",
            trees_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/trees{/sha}",
            statuses_url:
              "https://api.github.com/repos/Codertocat/Hello-World/statuses/{sha}",
            languages_url:
              "https://api.github.com/repos/Codertocat/Hello-World/languages",
            stargazers_url:
              "https://api.github.com/repos/Codertocat/Hello-World/stargazers",
            contributors_url:
              "https://api.github.com/repos/Codertocat/Hello-World/contributors",
            subscribers_url:
              "https://api.github.com/repos/Codertocat/Hello-World/subscribers",
            subscription_url:
              "https://api.github.com/repos/Codertocat/Hello-World/subscription",
            commits_url:
              "https://api.github.com/repos/Codertocat/Hello-World/commits{/sha}",
            git_commits_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/commits{/sha}",
            comments_url:
              "https://api.github.com/repos/Codertocat/Hello-World/comments{/number}",
            issue_comment_url:
              "https://api.github.com/repos/Codertocat/Hello-World/issues/comments{/number}",
            contents_url:
              "https://api.github.com/repos/Codertocat/Hello-World/contents/{+path}",
            compare_url:
              "https://api.github.com/repos/Codertocat/Hello-World/compare/{base}...{head}",
            merges_url:
              "https://api.github.com/repos/Codertocat/Hello-World/merges",
            archive_url:
              "https://api.github.com/repos/Codertocat/Hello-World/{archive_format}{/ref}",
            downloads_url:
              "https://api.github.com/repos/Codertocat/Hello-World/downloads",
            issues_url:
              "https://api.github.com/repos/Codertocat/Hello-World/issues{/number}",
            pulls_url:
              "https://api.github.com/repos/Codertocat/Hello-World/pulls{/number}",
            milestones_url:
              "https://api.github.com/repos/Codertocat/Hello-World/milestones{/number}",
            notifications_url:
              "https://api.github.com/repos/Codertocat/Hello-World/notifications{?since,all,participating}",
            labels_url:
              "https://api.github.com/repos/Codertocat/Hello-World/labels{/name}",
            releases_url:
              "https://api.github.com/repos/Codertocat/Hello-World/releases{/id}",
            deployments_url:
              "https://api.github.com/repos/Codertocat/Hello-World/deployments",
            created_at: "2019-05-15T15:19:25Z",
            updated_at: "2019-05-15T15:20:34Z",
            pushed_at: "2019-05-15T15:20:33Z",
            git_url: "git://github.com/Codertocat/Hello-World.git",
            ssh_url: "git@github.com:Codertocat/Hello-World.git",
            clone_url: "https://github.com/Codertocat/Hello-World.git",
            svn_url: "https://github.com/Codertocat/Hello-World",
            homepage: null,
            size: 0,
            stargazers_count: 0,
            watchers_count: 0,
            language: "Ruby",
            has_issues: true,
            has_projects: true,
            has_downloads: true,
            has_wiki: true,
            has_pages: true,
            forks_count: 0,
            mirror_url: null,
            archived: false,
            disabled: false,
            open_issues_count: 2,
            license: null,
            forks: 0,
            open_issues: 2,
            watchers: 0,
            default_branch: "master",
            allow_squash_merge: true,
            allow_merge_commit: true,
            allow_rebase_merge: true,
            delete_branch_on_merge: false,
          },
        },
        base: {
          label: "Codertocat:master",
          ref: "master",
          sha: "f95f852bd8fca8fcc58a9a2d6c842781e32a215e",
          user: {
            login: "Codertocat",
            id: 21031067,
            node_id: "MDQ6VXNlcjIxMDMxMDY3",
            avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
            gravatar_id: "",
            url: "https://api.github.com/users/Codertocat",
            html_url: "https://github.com/Codertocat",
            followers_url: "https://api.github.com/users/Codertocat/followers",
            following_url:
              "https://api.github.com/users/Codertocat/following{/other_user}",
            gists_url:
              "https://api.github.com/users/Codertocat/gists{/gist_id}",
            starred_url:
              "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
            subscriptions_url:
              "https://api.github.com/users/Codertocat/subscriptions",
            organizations_url: "https://api.github.com/users/Codertocat/orgs",
            repos_url: "https://api.github.com/users/Codertocat/repos",
            events_url:
              "https://api.github.com/users/Codertocat/events{/privacy}",
            received_events_url:
              "https://api.github.com/users/Codertocat/received_events",
            type: "User",
            site_admin: false,
          },
          repo: {
            id: 186853002,
            node_id: "MDEwOlJlcG9zaXRvcnkxODY4NTMwMDI=",
            name: "Hello-World",
            full_name: "Codertocat/Hello-World",
            private: false,
            owner: {
              login: "Codertocat",
              id: 21031067,
              node_id: "MDQ6VXNlcjIxMDMxMDY3",
              avatar_url:
                "https://avatars1.githubusercontent.com/u/21031067?v=4",
              gravatar_id: "",
              url: "https://api.github.com/users/Codertocat",
              html_url: "https://github.com/Codertocat",
              followers_url:
                "https://api.github.com/users/Codertocat/followers",
              following_url:
                "https://api.github.com/users/Codertocat/following{/other_user}",
              gists_url:
                "https://api.github.com/users/Codertocat/gists{/gist_id}",
              starred_url:
                "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
              subscriptions_url:
                "https://api.github.com/users/Codertocat/subscriptions",
              organizations_url: "https://api.github.com/users/Codertocat/orgs",
              repos_url: "https://api.github.com/users/Codertocat/repos",
              events_url:
                "https://api.github.com/users/Codertocat/events{/privacy}",
              received_events_url:
                "https://api.github.com/users/Codertocat/received_events",
              type: "User",
              site_admin: false,
            },
            html_url: "https://github.com/Codertocat/Hello-World",
            description: null,
            fork: false,
            url: "https://api.github.com/repos/Codertocat/Hello-World",
            forks_url:
              "https://api.github.com/repos/Codertocat/Hello-World/forks",
            keys_url:
              "https://api.github.com/repos/Codertocat/Hello-World/keys{/key_id}",
            collaborators_url:
              "https://api.github.com/repos/Codertocat/Hello-World/collaborators{/collaborator}",
            teams_url:
              "https://api.github.com/repos/Codertocat/Hello-World/teams",
            hooks_url:
              "https://api.github.com/repos/Codertocat/Hello-World/hooks",
            issue_events_url:
              "https://api.github.com/repos/Codertocat/Hello-World/issues/events{/number}",
            events_url:
              "https://api.github.com/repos/Codertocat/Hello-World/events",
            assignees_url:
              "https://api.github.com/repos/Codertocat/Hello-World/assignees{/user}",
            branches_url:
              "https://api.github.com/repos/Codertocat/Hello-World/branches{/branch}",
            tags_url:
              "https://api.github.com/repos/Codertocat/Hello-World/tags",
            blobs_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/blobs{/sha}",
            git_tags_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/tags{/sha}",
            git_refs_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/refs{/sha}",
            trees_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/trees{/sha}",
            statuses_url:
              "https://api.github.com/repos/Codertocat/Hello-World/statuses/{sha}",
            languages_url:
              "https://api.github.com/repos/Codertocat/Hello-World/languages",
            stargazers_url:
              "https://api.github.com/repos/Codertocat/Hello-World/stargazers",
            contributors_url:
              "https://api.github.com/repos/Codertocat/Hello-World/contributors",
            subscribers_url:
              "https://api.github.com/repos/Codertocat/Hello-World/subscribers",
            subscription_url:
              "https://api.github.com/repos/Codertocat/Hello-World/subscription",
            commits_url:
              "https://api.github.com/repos/Codertocat/Hello-World/commits{/sha}",
            git_commits_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/commits{/sha}",
            comments_url:
              "https://api.github.com/repos/Codertocat/Hello-World/comments{/number}",
            issue_comment_url:
              "https://api.github.com/repos/Codertocat/Hello-World/issues/comments{/number}",
            contents_url:
              "https://api.github.com/repos/Codertocat/Hello-World/contents/{+path}",
            compare_url:
              "https://api.github.com/repos/Codertocat/Hello-World/compare/{base}...{head}",
            merges_url:
              "https://api.github.com/repos/Codertocat/Hello-World/merges",
            archive_url:
              "https://api.github.com/repos/Codertocat/Hello-World/{archive_format}{/ref}",
            downloads_url:
              "https://api.github.com/repos/Codertocat/Hello-World/downloads",
            issues_url:
              "https://api.github.com/repos/Codertocat/Hello-World/issues{/number}",
            pulls_url:
              "https://api.github.com/repos/Codertocat/Hello-World/pulls{/number}",
            milestones_url:
              "https://api.github.com/repos/Codertocat/Hello-World/milestones{/number}",
            notifications_url:
              "https://api.github.com/repos/Codertocat/Hello-World/notifications{?since,all,participating}",
            labels_url:
              "https://api.github.com/repos/Codertocat/Hello-World/labels{/name}",
            releases_url:
              "https://api.github.com/repos/Codertocat/Hello-World/releases{/id}",
            deployments_url:
              "https://api.github.com/repos/Codertocat/Hello-World/deployments",
            created_at: "2019-05-15T15:19:25Z",
            updated_at: "2019-05-15T15:20:34Z",
            pushed_at: "2019-05-15T15:20:33Z",
            git_url: "git://github.com/Codertocat/Hello-World.git",
            ssh_url: "git@github.com:Codertocat/Hello-World.git",
            clone_url: "https://github.com/Codertocat/Hello-World.git",
            svn_url: "https://github.com/Codertocat/Hello-World",
            homepage: null,
            size: 0,
            stargazers_count: 0,
            watchers_count: 0,
            language: "Ruby",
            has_issues: true,
            has_projects: true,
            has_downloads: true,
            has_wiki: true,
            has_pages: true,
            forks_count: 0,
            mirror_url: null,
            archived: false,
            disabled: false,
            open_issues_count: 2,
            license: null,
            forks: 0,
            open_issues: 2,
            watchers: 0,
            default_branch: "master",
            allow_squash_merge: true,
            allow_merge_commit: true,
            allow_rebase_merge: true,
            delete_branch_on_merge: false,
          },
        },
        _links: {
          self: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/pulls/2",
          },
          html: {
            href: "https://github.com/Codertocat/Hello-World/pull/2",
          },
          issue: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/issues/2",
          },
          comments: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/issues/2/comments",
          },
          review_comments: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/pulls/2/comments",
          },
          review_comment: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/pulls/comments{/number}",
          },
          commits: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/pulls/2/commits",
          },
          statuses: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/statuses/ec26c3e57ca3a959ca5aad62de7213c562f8c821",
          },
        },
        author_association: "OWNER",
      },
      repository: {
        id: 186853002,
        node_id: "MDEwOlJlcG9zaXRvcnkxODY4NTMwMDI=",
        name: "Hello-World",
        full_name: "Codertocat/Hello-World",
        private: false,
        owner: {
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        html_url: "https://github.com/Codertocat/Hello-World",
        description: null,
        fork: false,
        url: "https://api.github.com/repos/Codertocat/Hello-World",
        forks_url: "https://api.github.com/repos/Codertocat/Hello-World/forks",
        keys_url:
          "https://api.github.com/repos/Codertocat/Hello-World/keys{/key_id}",
        collaborators_url:
          "https://api.github.com/repos/Codertocat/Hello-World/collaborators{/collaborator}",
        teams_url: "https://api.github.com/repos/Codertocat/Hello-World/teams",
        hooks_url: "https://api.github.com/repos/Codertocat/Hello-World/hooks",
        issue_events_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/events{/number}",
        events_url:
          "https://api.github.com/repos/Codertocat/Hello-World/events",
        assignees_url:
          "https://api.github.com/repos/Codertocat/Hello-World/assignees{/user}",
        branches_url:
          "https://api.github.com/repos/Codertocat/Hello-World/branches{/branch}",
        tags_url: "https://api.github.com/repos/Codertocat/Hello-World/tags",
        blobs_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/blobs{/sha}",
        git_tags_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/tags{/sha}",
        git_refs_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/refs{/sha}",
        trees_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/trees{/sha}",
        statuses_url:
          "https://api.github.com/repos/Codertocat/Hello-World/statuses/{sha}",
        languages_url:
          "https://api.github.com/repos/Codertocat/Hello-World/languages",
        stargazers_url:
          "https://api.github.com/repos/Codertocat/Hello-World/stargazers",
        contributors_url:
          "https://api.github.com/repos/Codertocat/Hello-World/contributors",
        subscribers_url:
          "https://api.github.com/repos/Codertocat/Hello-World/subscribers",
        subscription_url:
          "https://api.github.com/repos/Codertocat/Hello-World/subscription",
        commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/commits{/sha}",
        git_commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/commits{/sha}",
        comments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/comments{/number}",
        issue_comment_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/comments{/number}",
        contents_url:
          "https://api.github.com/repos/Codertocat/Hello-World/contents/{+path}",
        compare_url:
          "https://api.github.com/repos/Codertocat/Hello-World/compare/{base}...{head}",
        merges_url:
          "https://api.github.com/repos/Codertocat/Hello-World/merges",
        archive_url:
          "https://api.github.com/repos/Codertocat/Hello-World/{archive_format}{/ref}",
        downloads_url:
          "https://api.github.com/repos/Codertocat/Hello-World/downloads",
        issues_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues{/number}",
        pulls_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls{/number}",
        milestones_url:
          "https://api.github.com/repos/Codertocat/Hello-World/milestones{/number}",
        notifications_url:
          "https://api.github.com/repos/Codertocat/Hello-World/notifications{?since,all,participating}",
        labels_url:
          "https://api.github.com/repos/Codertocat/Hello-World/labels{/name}",
        releases_url:
          "https://api.github.com/repos/Codertocat/Hello-World/releases{/id}",
        deployments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/deployments",
        created_at: "2019-05-15T15:19:25Z",
        updated_at: "2019-05-15T15:20:34Z",
        pushed_at: "2019-05-15T15:20:33Z",
        git_url: "git://github.com/Codertocat/Hello-World.git",
        ssh_url: "git@github.com:Codertocat/Hello-World.git",
        clone_url: "https://github.com/Codertocat/Hello-World.git",
        svn_url: "https://github.com/Codertocat/Hello-World",
        homepage: null,
        size: 0,
        stargazers_count: 0,
        watchers_count: 0,
        language: "Ruby",
        has_issues: true,
        has_projects: true,
        has_downloads: true,
        has_wiki: true,
        has_pages: true,
        forks_count: 0,
        mirror_url: null,
        archived: false,
        disabled: false,
        open_issues_count: 2,
        license: null,
        forks: 0,
        open_issues: 2,
        watchers: 0,
        default_branch: "master",
      },
      sender: {
        login: "Codertocat",
        id: 21031067,
        node_id: "MDQ6VXNlcjIxMDMxMDY3",
        avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
        gravatar_id: "",
        url: "https://api.github.com/users/Codertocat",
        html_url: "https://github.com/Codertocat",
        followers_url: "https://api.github.com/users/Codertocat/followers",
        following_url:
          "https://api.github.com/users/Codertocat/following{/other_user}",
        gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
        starred_url:
          "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
        subscriptions_url:
          "https://api.github.com/users/Codertocat/subscriptions",
        organizations_url: "https://api.github.com/users/Codertocat/orgs",
        repos_url: "https://api.github.com/users/Codertocat/repos",
        events_url: "https://api.github.com/users/Codertocat/events{/privacy}",
        received_events_url:
          "https://api.github.com/users/Codertocat/received_events",
        type: "User",
        site_admin: false,
      },
    },
  },
  pull_request_review: {
    name: "A pull request review was submitted",
    payload: {
      action: "submitted",
      review: {
        id: 237895671,
        node_id: "MDE3OlB1bGxSZXF1ZXN0UmV2aWV3MjM3ODk1Njcx",
        user: {
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        body: null,
        commit_id: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
        submitted_at: "2019-05-15T15:20:38Z",
        state: "commented",
        html_url:
          "https://github.com/Codertocat/Hello-World/pull/2#pullrequestreview-237895671",
        pull_request_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls/2",
        author_association: "OWNER",
        _links: {
          html: {
            href: "https://github.com/Codertocat/Hello-World/pull/2#pullrequestreview-237895671",
          },
          pull_request: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/pulls/2",
          },
        },
      },
      pull_request: {
        url: "https://api.github.com/repos/Codertocat/Hello-World/pulls/2",
        id: 279147437,
        node_id: "MDExOlB1bGxSZXF1ZXN0Mjc5MTQ3NDM3",
        html_url: "https://github.com/Codertocat/Hello-World/pull/2",
        diff_url: "https://github.com/Codertocat/Hello-World/pull/2.diff",
        patch_url: "https://github.com/Codertocat/Hello-World/pull/2.patch",
        issue_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/2",
        number: 2,
        state: "open",
        locked: false,
        title: "Update the README with new information.",
        user: {
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        body: "This is a pretty simple change that we need to pull into master.",
        created_at: "2019-05-15T15:20:33Z",
        updated_at: "2019-05-15T15:20:38Z",
        closed_at: null,
        merged_at: null,
        merge_commit_sha: "c4295bd74fb0f4fda03689c3df3f2803b658fd85",
        assignee: null,
        assignees: [],
        requested_reviewers: [],
        requested_teams: [],
        labels: [],
        milestone: null,
        commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls/2/commits",
        review_comments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls/2/comments",
        review_comment_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls/comments{/number}",
        comments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/2/comments",
        statuses_url:
          "https://api.github.com/repos/Codertocat/Hello-World/statuses/ec26c3e57ca3a959ca5aad62de7213c562f8c821",
        head: {
          label: "Codertocat:changes",
          ref: "changes",
          sha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
          user: {
            login: "Codertocat",
            id: 21031067,
            node_id: "MDQ6VXNlcjIxMDMxMDY3",
            avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
            gravatar_id: "",
            url: "https://api.github.com/users/Codertocat",
            html_url: "https://github.com/Codertocat",
            followers_url: "https://api.github.com/users/Codertocat/followers",
            following_url:
              "https://api.github.com/users/Codertocat/following{/other_user}",
            gists_url:
              "https://api.github.com/users/Codertocat/gists{/gist_id}",
            starred_url:
              "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
            subscriptions_url:
              "https://api.github.com/users/Codertocat/subscriptions",
            organizations_url: "https://api.github.com/users/Codertocat/orgs",
            repos_url: "https://api.github.com/users/Codertocat/repos",
            events_url:
              "https://api.github.com/users/Codertocat/events{/privacy}",
            received_events_url:
              "https://api.github.com/users/Codertocat/received_events",
            type: "User",
            site_admin: false,
          },
          repo: {
            id: 186853002,
            node_id: "MDEwOlJlcG9zaXRvcnkxODY4NTMwMDI=",
            name: "Hello-World",
            full_name: "Codertocat/Hello-World",
            private: false,
            owner: {
              login: "Codertocat",
              id: 21031067,
              node_id: "MDQ6VXNlcjIxMDMxMDY3",
              avatar_url:
                "https://avatars1.githubusercontent.com/u/21031067?v=4",
              gravatar_id: "",
              url: "https://api.github.com/users/Codertocat",
              html_url: "https://github.com/Codertocat",
              followers_url:
                "https://api.github.com/users/Codertocat/followers",
              following_url:
                "https://api.github.com/users/Codertocat/following{/other_user}",
              gists_url:
                "https://api.github.com/users/Codertocat/gists{/gist_id}",
              starred_url:
                "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
              subscriptions_url:
                "https://api.github.com/users/Codertocat/subscriptions",
              organizations_url: "https://api.github.com/users/Codertocat/orgs",
              repos_url: "https://api.github.com/users/Codertocat/repos",
              events_url:
                "https://api.github.com/users/Codertocat/events{/privacy}",
              received_events_url:
                "https://api.github.com/users/Codertocat/received_events",
              type: "User",
              site_admin: false,
            },
            html_url: "https://github.com/Codertocat/Hello-World",
            description: null,
            fork: false,
            url: "https://api.github.com/repos/Codertocat/Hello-World",
            forks_url:
              "https://api.github.com/repos/Codertocat/Hello-World/forks",
            keys_url:
              "https://api.github.com/repos/Codertocat/Hello-World/keys{/key_id}",
            collaborators_url:
              "https://api.github.com/repos/Codertocat/Hello-World/collaborators{/collaborator}",
            teams_url:
              "https://api.github.com/repos/Codertocat/Hello-World/teams",
            hooks_url:
              "https://api.github.com/repos/Codertocat/Hello-World/hooks",
            issue_events_url:
              "https://api.github.com/repos/Codertocat/Hello-World/issues/events{/number}",
            events_url:
              "https://api.github.com/repos/Codertocat/Hello-World/events",
            assignees_url:
              "https://api.github.com/repos/Codertocat/Hello-World/assignees{/user}",
            branches_url:
              "https://api.github.com/repos/Codertocat/Hello-World/branches{/branch}",
            tags_url:
              "https://api.github.com/repos/Codertocat/Hello-World/tags",
            blobs_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/blobs{/sha}",
            git_tags_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/tags{/sha}",
            git_refs_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/refs{/sha}",
            trees_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/trees{/sha}",
            statuses_url:
              "https://api.github.com/repos/Codertocat/Hello-World/statuses/{sha}",
            languages_url:
              "https://api.github.com/repos/Codertocat/Hello-World/languages",
            stargazers_url:
              "https://api.github.com/repos/Codertocat/Hello-World/stargazers",
            contributors_url:
              "https://api.github.com/repos/Codertocat/Hello-World/contributors",
            subscribers_url:
              "https://api.github.com/repos/Codertocat/Hello-World/subscribers",
            subscription_url:
              "https://api.github.com/repos/Codertocat/Hello-World/subscription",
            commits_url:
              "https://api.github.com/repos/Codertocat/Hello-World/commits{/sha}",
            git_commits_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/commits{/sha}",
            comments_url:
              "https://api.github.com/repos/Codertocat/Hello-World/comments{/number}",
            issue_comment_url:
              "https://api.github.com/repos/Codertocat/Hello-World/issues/comments{/number}",
            contents_url:
              "https://api.github.com/repos/Codertocat/Hello-World/contents/{+path}",
            compare_url:
              "https://api.github.com/repos/Codertocat/Hello-World/compare/{base}...{head}",
            merges_url:
              "https://api.github.com/repos/Codertocat/Hello-World/merges",
            archive_url:
              "https://api.github.com/repos/Codertocat/Hello-World/{archive_format}{/ref}",
            downloads_url:
              "https://api.github.com/repos/Codertocat/Hello-World/downloads",
            issues_url:
              "https://api.github.com/repos/Codertocat/Hello-World/issues{/number}",
            pulls_url:
              "https://api.github.com/repos/Codertocat/Hello-World/pulls{/number}",
            milestones_url:
              "https://api.github.com/repos/Codertocat/Hello-World/milestones{/number}",
            notifications_url:
              "https://api.github.com/repos/Codertocat/Hello-World/notifications{?since,all,participating}",
            labels_url:
              "https://api.github.com/repos/Codertocat/Hello-World/labels{/name}",
            releases_url:
              "https://api.github.com/repos/Codertocat/Hello-World/releases{/id}",
            deployments_url:
              "https://api.github.com/repos/Codertocat/Hello-World/deployments",
            created_at: "2019-05-15T15:19:25Z",
            updated_at: "2019-05-15T15:20:34Z",
            pushed_at: "2019-05-15T15:20:33Z",
            git_url: "git://github.com/Codertocat/Hello-World.git",
            ssh_url: "git@github.com:Codertocat/Hello-World.git",
            clone_url: "https://github.com/Codertocat/Hello-World.git",
            svn_url: "https://github.com/Codertocat/Hello-World",
            homepage: null,
            size: 0,
            stargazers_count: 0,
            watchers_count: 0,
            language: "Ruby",
            has_issues: true,
            has_projects: true,
            has_downloads: true,
            has_wiki: true,
            has_pages: true,
            forks_count: 0,
            mirror_url: null,
            archived: false,
            disabled: false,
            open_issues_count: 2,
            license: null,
            forks: 0,
            open_issues: 2,
            watchers: 0,
            default_branch: "master",
            allow_squash_merge: true,
            allow_merge_commit: true,
            allow_rebase_merge: true,
            delete_branch_on_merge: false,
          },
        },
        base: {
          label: "Codertocat:master",
          ref: "master",
          sha: "f95f852bd8fca8fcc58a9a2d6c842781e32a215e",
          user: {
            login: "Codertocat",
            id: 21031067,
            node_id: "MDQ6VXNlcjIxMDMxMDY3",
            avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
            gravatar_id: "",
            url: "https://api.github.com/users/Codertocat",
            html_url: "https://github.com/Codertocat",
            followers_url: "https://api.github.com/users/Codertocat/followers",
            following_url:
              "https://api.github.com/users/Codertocat/following{/other_user}",
            gists_url:
              "https://api.github.com/users/Codertocat/gists{/gist_id}",
            starred_url:
              "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
            subscriptions_url:
              "https://api.github.com/users/Codertocat/subscriptions",
            organizations_url: "https://api.github.com/users/Codertocat/orgs",
            repos_url: "https://api.github.com/users/Codertocat/repos",
            events_url:
              "https://api.github.com/users/Codertocat/events{/privacy}",
            received_events_url:
              "https://api.github.com/users/Codertocat/received_events",
            type: "User",
            site_admin: false,
          },
          repo: {
            id: 186853002,
            node_id: "MDEwOlJlcG9zaXRvcnkxODY4NTMwMDI=",
            name: "Hello-World",
            full_name: "Codertocat/Hello-World",
            private: false,
            owner: {
              login: "Codertocat",
              id: 21031067,
              node_id: "MDQ6VXNlcjIxMDMxMDY3",
              avatar_url:
                "https://avatars1.githubusercontent.com/u/21031067?v=4",
              gravatar_id: "",
              url: "https://api.github.com/users/Codertocat",
              html_url: "https://github.com/Codertocat",
              followers_url:
                "https://api.github.com/users/Codertocat/followers",
              following_url:
                "https://api.github.com/users/Codertocat/following{/other_user}",
              gists_url:
                "https://api.github.com/users/Codertocat/gists{/gist_id}",
              starred_url:
                "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
              subscriptions_url:
                "https://api.github.com/users/Codertocat/subscriptions",
              organizations_url: "https://api.github.com/users/Codertocat/orgs",
              repos_url: "https://api.github.com/users/Codertocat/repos",
              events_url:
                "https://api.github.com/users/Codertocat/events{/privacy}",
              received_events_url:
                "https://api.github.com/users/Codertocat/received_events",
              type: "User",
              site_admin: false,
            },
            html_url: "https://github.com/Codertocat/Hello-World",
            description: null,
            fork: false,
            url: "https://api.github.com/repos/Codertocat/Hello-World",
            forks_url:
              "https://api.github.com/repos/Codertocat/Hello-World/forks",
            keys_url:
              "https://api.github.com/repos/Codertocat/Hello-World/keys{/key_id}",
            collaborators_url:
              "https://api.github.com/repos/Codertocat/Hello-World/collaborators{/collaborator}",
            teams_url:
              "https://api.github.com/repos/Codertocat/Hello-World/teams",
            hooks_url:
              "https://api.github.com/repos/Codertocat/Hello-World/hooks",
            issue_events_url:
              "https://api.github.com/repos/Codertocat/Hello-World/issues/events{/number}",
            events_url:
              "https://api.github.com/repos/Codertocat/Hello-World/events",
            assignees_url:
              "https://api.github.com/repos/Codertocat/Hello-World/assignees{/user}",
            branches_url:
              "https://api.github.com/repos/Codertocat/Hello-World/branches{/branch}",
            tags_url:
              "https://api.github.com/repos/Codertocat/Hello-World/tags",
            blobs_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/blobs{/sha}",
            git_tags_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/tags{/sha}",
            git_refs_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/refs{/sha}",
            trees_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/trees{/sha}",
            statuses_url:
              "https://api.github.com/repos/Codertocat/Hello-World/statuses/{sha}",
            languages_url:
              "https://api.github.com/repos/Codertocat/Hello-World/languages",
            stargazers_url:
              "https://api.github.com/repos/Codertocat/Hello-World/stargazers",
            contributors_url:
              "https://api.github.com/repos/Codertocat/Hello-World/contributors",
            subscribers_url:
              "https://api.github.com/repos/Codertocat/Hello-World/subscribers",
            subscription_url:
              "https://api.github.com/repos/Codertocat/Hello-World/subscription",
            commits_url:
              "https://api.github.com/repos/Codertocat/Hello-World/commits{/sha}",
            git_commits_url:
              "https://api.github.com/repos/Codertocat/Hello-World/git/commits{/sha}",
            comments_url:
              "https://api.github.com/repos/Codertocat/Hello-World/comments{/number}",
            issue_comment_url:
              "https://api.github.com/repos/Codertocat/Hello-World/issues/comments{/number}",
            contents_url:
              "https://api.github.com/repos/Codertocat/Hello-World/contents/{+path}",
            compare_url:
              "https://api.github.com/repos/Codertocat/Hello-World/compare/{base}...{head}",
            merges_url:
              "https://api.github.com/repos/Codertocat/Hello-World/merges",
            archive_url:
              "https://api.github.com/repos/Codertocat/Hello-World/{archive_format}{/ref}",
            downloads_url:
              "https://api.github.com/repos/Codertocat/Hello-World/downloads",
            issues_url:
              "https://api.github.com/repos/Codertocat/Hello-World/issues{/number}",
            pulls_url:
              "https://api.github.com/repos/Codertocat/Hello-World/pulls{/number}",
            milestones_url:
              "https://api.github.com/repos/Codertocat/Hello-World/milestones{/number}",
            notifications_url:
              "https://api.github.com/repos/Codertocat/Hello-World/notifications{?since,all,participating}",
            labels_url:
              "https://api.github.com/repos/Codertocat/Hello-World/labels{/name}",
            releases_url:
              "https://api.github.com/repos/Codertocat/Hello-World/releases{/id}",
            deployments_url:
              "https://api.github.com/repos/Codertocat/Hello-World/deployments",
            created_at: "2019-05-15T15:19:25Z",
            updated_at: "2019-05-15T15:20:34Z",
            pushed_at: "2019-05-15T15:20:33Z",
            git_url: "git://github.com/Codertocat/Hello-World.git",
            ssh_url: "git@github.com:Codertocat/Hello-World.git",
            clone_url: "https://github.com/Codertocat/Hello-World.git",
            svn_url: "https://github.com/Codertocat/Hello-World",
            homepage: null,
            size: 0,
            stargazers_count: 0,
            watchers_count: 0,
            language: "Ruby",
            has_issues: true,
            has_projects: true,
            has_downloads: true,
            has_wiki: true,
            has_pages: true,
            forks_count: 0,
            mirror_url: null,
            archived: false,
            disabled: false,
            open_issues_count: 2,
            license: null,
            forks: 0,
            open_issues: 2,
            watchers: 0,
            default_branch: "master",
            allow_squash_merge: true,
            allow_merge_commit: true,
            allow_rebase_merge: true,
            delete_branch_on_merge: false,
          },
        },
        _links: {
          self: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/pulls/2",
          },
          html: {
            href: "https://github.com/Codertocat/Hello-World/pull/2",
          },
          issue: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/issues/2",
          },
          comments: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/issues/2/comments",
          },
          review_comments: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/pulls/2/comments",
          },
          review_comment: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/pulls/comments{/number}",
          },
          commits: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/pulls/2/commits",
          },
          statuses: {
            href: "https://api.github.com/repos/Codertocat/Hello-World/statuses/ec26c3e57ca3a959ca5aad62de7213c562f8c821",
          },
        },
        author_association: "OWNER",
      },
      repository: {
        id: 186853002,
        node_id: "MDEwOlJlcG9zaXRvcnkxODY4NTMwMDI=",
        name: "Hello-World",
        full_name: "Codertocat/Hello-World",
        private: false,
        owner: {
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        html_url: "https://github.com/Codertocat/Hello-World",
        description: null,
        fork: false,
        url: "https://api.github.com/repos/Codertocat/Hello-World",
        forks_url: "https://api.github.com/repos/Codertocat/Hello-World/forks",
        keys_url:
          "https://api.github.com/repos/Codertocat/Hello-World/keys{/key_id}",
        collaborators_url:
          "https://api.github.com/repos/Codertocat/Hello-World/collaborators{/collaborator}",
        teams_url: "https://api.github.com/repos/Codertocat/Hello-World/teams",
        hooks_url: "https://api.github.com/repos/Codertocat/Hello-World/hooks",
        issue_events_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/events{/number}",
        events_url:
          "https://api.github.com/repos/Codertocat/Hello-World/events",
        assignees_url:
          "https://api.github.com/repos/Codertocat/Hello-World/assignees{/user}",
        branches_url:
          "https://api.github.com/repos/Codertocat/Hello-World/branches{/branch}",
        tags_url: "https://api.github.com/repos/Codertocat/Hello-World/tags",
        blobs_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/blobs{/sha}",
        git_tags_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/tags{/sha}",
        git_refs_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/refs{/sha}",
        trees_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/trees{/sha}",
        statuses_url:
          "https://api.github.com/repos/Codertocat/Hello-World/statuses/{sha}",
        languages_url:
          "https://api.github.com/repos/Codertocat/Hello-World/languages",
        stargazers_url:
          "https://api.github.com/repos/Codertocat/Hello-World/stargazers",
        contributors_url:
          "https://api.github.com/repos/Codertocat/Hello-World/contributors",
        subscribers_url:
          "https://api.github.com/repos/Codertocat/Hello-World/subscribers",
        subscription_url:
          "https://api.github.com/repos/Codertocat/Hello-World/subscription",
        commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/commits{/sha}",
        git_commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/commits{/sha}",
        comments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/comments{/number}",
        issue_comment_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/comments{/number}",
        contents_url:
          "https://api.github.com/repos/Codertocat/Hello-World/contents/{+path}",
        compare_url:
          "https://api.github.com/repos/Codertocat/Hello-World/compare/{base}...{head}",
        merges_url:
          "https://api.github.com/repos/Codertocat/Hello-World/merges",
        archive_url:
          "https://api.github.com/repos/Codertocat/Hello-World/{archive_format}{/ref}",
        downloads_url:
          "https://api.github.com/repos/Codertocat/Hello-World/downloads",
        issues_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues{/number}",
        pulls_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls{/number}",
        milestones_url:
          "https://api.github.com/repos/Codertocat/Hello-World/milestones{/number}",
        notifications_url:
          "https://api.github.com/repos/Codertocat/Hello-World/notifications{?since,all,participating}",
        labels_url:
          "https://api.github.com/repos/Codertocat/Hello-World/labels{/name}",
        releases_url:
          "https://api.github.com/repos/Codertocat/Hello-World/releases{/id}",
        deployments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/deployments",
        created_at: "2019-05-15T15:19:25Z",
        updated_at: "2019-05-15T15:20:34Z",
        pushed_at: "2019-05-15T15:20:33Z",
        git_url: "git://github.com/Codertocat/Hello-World.git",
        ssh_url: "git@github.com:Codertocat/Hello-World.git",
        clone_url: "https://github.com/Codertocat/Hello-World.git",
        svn_url: "https://github.com/Codertocat/Hello-World",
        homepage: null,
        size: 0,
        stargazers_count: 0,
        watchers_count: 0,
        language: "Ruby",
        has_issues: true,
        has_projects: true,
        has_downloads: true,
        has_wiki: true,
        has_pages: true,
        forks_count: 0,
        mirror_url: null,
        archived: false,
        disabled: false,
        open_issues_count: 2,
        license: null,
        forks: 0,
        open_issues: 2,
        watchers: 0,
        default_branch: "master",
      },
      sender: {
        login: "Codertocat",
        id: 21031067,
        node_id: "MDQ6VXNlcjIxMDMxMDY3",
        avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
        gravatar_id: "",
        url: "https://api.github.com/users/Codertocat",
        html_url: "https://github.com/Codertocat",
        followers_url: "https://api.github.com/users/Codertocat/followers",
        following_url:
          "https://api.github.com/users/Codertocat/following{/other_user}",
        gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
        starred_url:
          "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
        subscriptions_url:
          "https://api.github.com/users/Codertocat/subscriptions",
        organizations_url: "https://api.github.com/users/Codertocat/orgs",
        repos_url: "https://api.github.com/users/Codertocat/repos",
        events_url: "https://api.github.com/users/Codertocat/events{/privacy}",
        received_events_url:
          "https://api.github.com/users/Codertocat/received_events",
        type: "User",
        site_admin: false,
      },
    },
  },
  push: {
    name: "One or more commits are pushed to a repository branch or tag.",
    payload: {
      ref: "refs/tags/simple-tag",
      before: "0000000000000000000000000000000000000000",
      after: "6113728f27ae82c7b1a177c8d03f9e96e0adf246",
      created: true,
      deleted: false,
      forced: false,
      base_ref: null,
      compare: "https://github.com/Codertocat/Hello-World/compare/simple-tag",
      commits: [],
      head_commit: {
        id: "6113728f27ae82c7b1a177c8d03f9e96e0adf246",
        tree_id: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        distinct: true,
        message: "Adding a .gitignore file",
        timestamp: "2019-05-15T15:20:41Z",
        url: "https://github.com/Codertocat/Hello-World/commit/6113728f27ae82c7b1a177c8d03f9e96e0adf246",
        author: {
          name: "Codertocat",
          email: "21031067+Codertocat@users.noreply.github.com",
          username: "Codertocat",
        },
        committer: {
          name: "Codertocat",
          email: "21031067+Codertocat@users.noreply.github.com",
          username: "Codertocat",
        },
        added: [".gitignore"],
        removed: [],
        modified: [],
      },
      repository: {
        id: 186853002,
        node_id: "MDEwOlJlcG9zaXRvcnkxODY4NTMwMDI=",
        name: "Hello-World",
        full_name: "Codertocat/Hello-World",
        private: false,
        owner: {
          name: "Codertocat",
          email: "21031067+Codertocat@users.noreply.github.com",
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        html_url: "https://github.com/Codertocat/Hello-World",
        description: null,
        fork: false,
        url: "https://github.com/Codertocat/Hello-World",
        forks_url: "https://api.github.com/repos/Codertocat/Hello-World/forks",
        keys_url:
          "https://api.github.com/repos/Codertocat/Hello-World/keys{/key_id}",
        collaborators_url:
          "https://api.github.com/repos/Codertocat/Hello-World/collaborators{/collaborator}",
        teams_url: "https://api.github.com/repos/Codertocat/Hello-World/teams",
        hooks_url: "https://api.github.com/repos/Codertocat/Hello-World/hooks",
        issue_events_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/events{/number}",
        events_url:
          "https://api.github.com/repos/Codertocat/Hello-World/events",
        assignees_url:
          "https://api.github.com/repos/Codertocat/Hello-World/assignees{/user}",
        branches_url:
          "https://api.github.com/repos/Codertocat/Hello-World/branches{/branch}",
        tags_url: "https://api.github.com/repos/Codertocat/Hello-World/tags",
        blobs_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/blobs{/sha}",
        git_tags_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/tags{/sha}",
        git_refs_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/refs{/sha}",
        trees_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/trees{/sha}",
        statuses_url:
          "https://api.github.com/repos/Codertocat/Hello-World/statuses/{sha}",
        languages_url:
          "https://api.github.com/repos/Codertocat/Hello-World/languages",
        stargazers_url:
          "https://api.github.com/repos/Codertocat/Hello-World/stargazers",
        contributors_url:
          "https://api.github.com/repos/Codertocat/Hello-World/contributors",
        subscribers_url:
          "https://api.github.com/repos/Codertocat/Hello-World/subscribers",
        subscription_url:
          "https://api.github.com/repos/Codertocat/Hello-World/subscription",
        commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/commits{/sha}",
        git_commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/commits{/sha}",
        comments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/comments{/number}",
        issue_comment_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/comments{/number}",
        contents_url:
          "https://api.github.com/repos/Codertocat/Hello-World/contents/{+path}",
        compare_url:
          "https://api.github.com/repos/Codertocat/Hello-World/compare/{base}...{head}",
        merges_url:
          "https://api.github.com/repos/Codertocat/Hello-World/merges",
        archive_url:
          "https://api.github.com/repos/Codertocat/Hello-World/{archive_format}{/ref}",
        downloads_url:
          "https://api.github.com/repos/Codertocat/Hello-World/downloads",
        issues_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues{/number}",
        pulls_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls{/number}",
        milestones_url:
          "https://api.github.com/repos/Codertocat/Hello-World/milestones{/number}",
        notifications_url:
          "https://api.github.com/repos/Codertocat/Hello-World/notifications{?since,all,participating}",
        labels_url:
          "https://api.github.com/repos/Codertocat/Hello-World/labels{/name}",
        releases_url:
          "https://api.github.com/repos/Codertocat/Hello-World/releases{/id}",
        deployments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/deployments",
        created_at: 1557933565,
        updated_at: "2019-05-15T15:20:41Z",
        pushed_at: 1557933657,
        git_url: "git://github.com/Codertocat/Hello-World.git",
        ssh_url: "git@github.com:Codertocat/Hello-World.git",
        clone_url: "https://github.com/Codertocat/Hello-World.git",
        svn_url: "https://github.com/Codertocat/Hello-World",
        homepage: null,
        size: 0,
        stargazers_count: 0,
        watchers_count: 0,
        language: "Ruby",
        has_issues: true,
        has_projects: true,
        has_downloads: true,
        has_wiki: true,
        has_pages: true,
        forks_count: 1,
        mirror_url: null,
        archived: false,
        disabled: false,
        open_issues_count: 2,
        license: null,
        forks: 1,
        open_issues: 2,
        watchers: 0,
        default_branch: "master",
        stargazers: 0,
        master_branch: "master",
      },
      pusher: {
        name: "Codertocat",
        email: "21031067+Codertocat@users.noreply.github.com",
      },
      sender: {
        login: "Codertocat",
        id: 21031067,
        node_id: "MDQ6VXNlcjIxMDMxMDY3",
        avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
        gravatar_id: "",
        url: "https://api.github.com/users/Codertocat",
        html_url: "https://github.com/Codertocat",
        followers_url: "https://api.github.com/users/Codertocat/followers",
        following_url:
          "https://api.github.com/users/Codertocat/following{/other_user}",
        gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
        starred_url:
          "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
        subscriptions_url:
          "https://api.github.com/users/Codertocat/subscriptions",
        organizations_url: "https://api.github.com/users/Codertocat/orgs",
        repos_url: "https://api.github.com/users/Codertocat/repos",
        events_url: "https://api.github.com/users/Codertocat/events{/privacy}",
        received_events_url:
          "https://api.github.com/users/Codertocat/received_events",
        type: "User",
        site_admin: false,
      },
    },
  },
  star: {
    name: "A GitHub star was added to a repo",
    payload: {
      action: "created",
      starred_at: "2019-05-15T15:20:40Z",
      repository: {
        id: 186853002,
        node_id: "MDEwOlJlcG9zaXRvcnkxODY4NTMwMDI=",
        name: "Hello-World",
        full_name: "Codertocat/Hello-World",
        private: false,
        owner: {
          login: "Codertocat",
          id: 21031067,
          node_id: "MDQ6VXNlcjIxMDMxMDY3",
          avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
          gravatar_id: "",
          url: "https://api.github.com/users/Codertocat",
          html_url: "https://github.com/Codertocat",
          followers_url: "https://api.github.com/users/Codertocat/followers",
          following_url:
            "https://api.github.com/users/Codertocat/following{/other_user}",
          gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
          starred_url:
            "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
          subscriptions_url:
            "https://api.github.com/users/Codertocat/subscriptions",
          organizations_url: "https://api.github.com/users/Codertocat/orgs",
          repos_url: "https://api.github.com/users/Codertocat/repos",
          events_url:
            "https://api.github.com/users/Codertocat/events{/privacy}",
          received_events_url:
            "https://api.github.com/users/Codertocat/received_events",
          type: "User",
          site_admin: false,
        },
        html_url: "https://github.com/Codertocat/Hello-World",
        description: null,
        fork: false,
        url: "https://api.github.com/repos/Codertocat/Hello-World",
        forks_url: "https://api.github.com/repos/Codertocat/Hello-World/forks",
        keys_url:
          "https://api.github.com/repos/Codertocat/Hello-World/keys{/key_id}",
        collaborators_url:
          "https://api.github.com/repos/Codertocat/Hello-World/collaborators{/collaborator}",
        teams_url: "https://api.github.com/repos/Codertocat/Hello-World/teams",
        hooks_url: "https://api.github.com/repos/Codertocat/Hello-World/hooks",
        issue_events_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/events{/number}",
        events_url:
          "https://api.github.com/repos/Codertocat/Hello-World/events",
        assignees_url:
          "https://api.github.com/repos/Codertocat/Hello-World/assignees{/user}",
        branches_url:
          "https://api.github.com/repos/Codertocat/Hello-World/branches{/branch}",
        tags_url: "https://api.github.com/repos/Codertocat/Hello-World/tags",
        blobs_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/blobs{/sha}",
        git_tags_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/tags{/sha}",
        git_refs_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/refs{/sha}",
        trees_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/trees{/sha}",
        statuses_url:
          "https://api.github.com/repos/Codertocat/Hello-World/statuses/{sha}",
        languages_url:
          "https://api.github.com/repos/Codertocat/Hello-World/languages",
        stargazers_url:
          "https://api.github.com/repos/Codertocat/Hello-World/stargazers",
        contributors_url:
          "https://api.github.com/repos/Codertocat/Hello-World/contributors",
        subscribers_url:
          "https://api.github.com/repos/Codertocat/Hello-World/subscribers",
        subscription_url:
          "https://api.github.com/repos/Codertocat/Hello-World/subscription",
        commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/commits{/sha}",
        git_commits_url:
          "https://api.github.com/repos/Codertocat/Hello-World/git/commits{/sha}",
        comments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/comments{/number}",
        issue_comment_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues/comments{/number}",
        contents_url:
          "https://api.github.com/repos/Codertocat/Hello-World/contents/{+path}",
        compare_url:
          "https://api.github.com/repos/Codertocat/Hello-World/compare/{base}...{head}",
        merges_url:
          "https://api.github.com/repos/Codertocat/Hello-World/merges",
        archive_url:
          "https://api.github.com/repos/Codertocat/Hello-World/{archive_format}{/ref}",
        downloads_url:
          "https://api.github.com/repos/Codertocat/Hello-World/downloads",
        issues_url:
          "https://api.github.com/repos/Codertocat/Hello-World/issues{/number}",
        pulls_url:
          "https://api.github.com/repos/Codertocat/Hello-World/pulls{/number}",
        milestones_url:
          "https://api.github.com/repos/Codertocat/Hello-World/milestones{/number}",
        notifications_url:
          "https://api.github.com/repos/Codertocat/Hello-World/notifications{?since,all,participating}",
        labels_url:
          "https://api.github.com/repos/Codertocat/Hello-World/labels{/name}",
        releases_url:
          "https://api.github.com/repos/Codertocat/Hello-World/releases{/id}",
        deployments_url:
          "https://api.github.com/repos/Codertocat/Hello-World/deployments",
        created_at: "2019-05-15T15:19:25Z",
        updated_at: "2019-05-15T15:20:40Z",
        pushed_at: "2019-05-15T15:20:33Z",
        git_url: "git://github.com/Codertocat/Hello-World.git",
        ssh_url: "git@github.com:Codertocat/Hello-World.git",
        clone_url: "https://github.com/Codertocat/Hello-World.git",
        svn_url: "https://github.com/Codertocat/Hello-World",
        homepage: null,
        size: 0,
        stargazers_count: 1,
        watchers_count: 1,
        language: "Ruby",
        has_issues: true,
        has_projects: true,
        has_downloads: true,
        has_wiki: true,
        has_pages: true,
        forks_count: 0,
        mirror_url: null,
        archived: false,
        disabled: false,
        open_issues_count: 2,
        license: null,
        forks: 0,
        open_issues: 2,
        watchers: 1,
        default_branch: "master",
      },
      sender: {
        login: "Codertocat",
        id: 21031067,
        node_id: "MDQ6VXNlcjIxMDMxMDY3",
        avatar_url: "https://avatars1.githubusercontent.com/u/21031067?v=4",
        gravatar_id: "",
        url: "https://api.github.com/users/Codertocat",
        html_url: "https://github.com/Codertocat",
        followers_url: "https://api.github.com/users/Codertocat/followers",
        following_url:
          "https://api.github.com/users/Codertocat/following{/other_user}",
        gists_url: "https://api.github.com/users/Codertocat/gists{/gist_id}",
        starred_url:
          "https://api.github.com/users/Codertocat/starred{/owner}{/repo}",
        subscriptions_url:
          "https://api.github.com/users/Codertocat/subscriptions",
        organizations_url: "https://api.github.com/users/Codertocat/orgs",
        repos_url: "https://api.github.com/users/Codertocat/repos",
        events_url: "https://api.github.com/users/Codertocat/events{/privacy}",
        received_events_url:
          "https://api.github.com/users/Codertocat/received_events",
        type: "User",
        site_admin: false,
      },
    },
  },
};
