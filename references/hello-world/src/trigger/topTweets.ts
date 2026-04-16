import { logger, schedules } from "@trigger.dev/sdk";

type XPublicMetrics = {
  retweet_count: number;
  reply_count: number;
  like_count: number;
  quote_count: number;
  impression_count?: number;
};

type XTweet = {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
  public_metrics: XPublicMetrics;
};

type XUser = {
  id: string;
  name: string;
  username: string;
  description: string;
  public_metrics: {
    followers_count: number;
    following_count: number;
    tweet_count: number;
    listed_count: number;
  };
};

type XSearchResponse = {
  data?: XTweet[];
  includes?: { users?: XUser[] };
  meta?: { result_count: number };
};

type TopTweet = {
  topic: string;
  tweet: {
    id: string;
    text: string;
    url: string;
    createdAt: string;
    metrics: XPublicMetrics;
    engagementScore: number;
  };
  author: {
    id: string;
    name: string;
    username: string;
    bio: string;
    followersCount: number;
  };
};

async function fetchTopTweets(topic: string, query: string, bearerToken: string) {
  const url = new URL("https://api.x.com/2/tweets/search/recent");
  url.searchParams.set("query", `${query} -is:retweet lang:en`);
  url.searchParams.set("max_results", "100");
  url.searchParams.set("tweet.fields", "public_metrics,created_at,author_id");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "description,public_metrics,name,username");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X API ${res.status} for topic "${topic}": ${body}`);
  }

  const json = (await res.json()) as XSearchResponse;
  const tweets = json.data ?? [];
  const users = new Map((json.includes?.users ?? []).map((u) => [u.id, u]));

  return tweets
    .map((t) => {
      const m = t.public_metrics;
      const engagementScore = m.like_count + m.retweet_count + m.reply_count + m.quote_count;
      const user = users.get(t.author_id);
      if (!user) return null;
      const top: TopTweet = {
        topic,
        tweet: {
          id: t.id,
          text: t.text,
          url: `https://x.com/${user.username}/status/${t.id}`,
          createdAt: t.created_at,
          metrics: m,
          engagementScore,
        },
        author: {
          id: user.id,
          name: user.name,
          username: user.username,
          bio: user.description,
          followersCount: user.public_metrics.followers_count,
        },
      };
      return top;
    })
    .filter((t): t is TopTweet => t !== null)
    .sort((a, b) => b.tweet.engagementScore - a.tweet.engagementScore);
}

export const topTweetsSchedule = schedules.task({
  id: "top-tweets-daily",
  cron: "0 9 * * *",
  maxDuration: 120,
  run: async () => {
    const bearerToken = process.env.X_BEARER_TOKEN;
    if (!bearerToken) {
      throw new Error("X_BEARER_TOKEN env var is required");
    }

    const topics: Array<{ topic: string; query: string }> = [
      { topic: "programming", query: "(programming OR coding OR software)" },
      { topic: "AI", query: "(AI OR \"artificial intelligence\" OR LLM)" },
    ];

    const results: Record<string, TopTweet | null> = {};

    for (const { topic, query } of topics) {
      const ranked = await fetchTopTweets(topic, query, bearerToken);
      const top = ranked[0] ?? null;
      results[topic] = top;

      if (top) {
        logger.info(`Top ${topic} tweet`, {
          url: top.tweet.url,
          engagementScore: top.tweet.engagementScore,
          metrics: top.tweet.metrics,
          author: top.author,
          text: top.tweet.text,
        });
      } else {
        logger.warn(`No tweets found for topic "${topic}"`);
      }
    }

    return results;
  },
});
