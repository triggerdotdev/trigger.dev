import { describe, beforeEach, expect, test } from "vitest";
import endpoints from "../endpoints/endpoints";
import nock from "nock";
const authToken = () => process.env.AIRTABLE_TOKEN ?? "";

describe("airtable.endpoints", async () => {
  beforeEach(async () => {
    nock.cleanAll();
  });

  test("getRecord", async () => {
    nock("https://api.airtable.com:443", { encodedQueryParams: true })
      .get("/v0/appBlf3KsalIQeMUo/tblvXn2TOeVPC9c6m/recHcnB1MbBr9Rd2P")
      .reply(
        200,
        [
          "1f8b08000000000000ffad945993a24810c7bf4a074f33114d73c9a16f82a2a2a01ca2b0b161701497c521142274f8dd177b26b6f77da7a21e2a237f5951ffccacfcc4d2109b613508d6412152aa2fd65323a40fd83b16d4c04320b4d21c8c044dd20c4e5238c958143d23d919cb7c9024e98e6094021836d8ec135be6152c7bf0e2652f45c99bd82204eaaeac51328287a42c5ebe1f14cdfc7c9bb01cce0b537274ac8117364989b0d95f9fbf1ee421c4a47ed7efcfc79db3a3d8fd487569385e339bb2e43b9680344e469e2747a3ade118922054353382b8b31f5e5a23cf87a06d401d94050205fa08ca9cb85304c57e6d8ee726c284fc5a841c84a5d58bd5a216a13637c24347c12626aec2e15e876ab85d9daf3a77275bb6c66d7fce369eaa32a46f3ddcc56edb9969d425c3d00eb27b51add5c52b605b4a3e79091f91bdd2e92653726b73eed676c35da341578e4bbd343be9d4f095ba6c8ea229e71d21c65acce0a745ef6bcc3619fcf4129a4ec94b76b249132a9ad0f2f42177d9246a375f1987a0f0beea92fc4e1d5eb57505014ebffda07e7e54453c624d3a8c0835a5689e7ec7505fbd02d2dc8b01f10b40499bfb8597c2afea35b907e1ebf07ff349e3a17a768a2b1e21db95b23a5ae0072326b4cc8e7952b91f80e6c08c53c9e8beb80c686dd9bea4c9125be902f21f4ce55b1a8578cab542cd58f2ea5e9560a41d19f5b002c96d834fefe9dc7550ba54cd79c9c74451986eb0aff03ed71d86a6e3b65e4cbcadc164ed6121fbbda03ef455adde6e001dbf9b6832fdee21867bbe63d0ab63f027c4eb10f7c5cd4d531cb7898b98df2f694ed209b95b1d7d11f6d3cc146de502fa5d9631ec85da26bb1b970912589aa7d87f38c2b982f1cdc12fbe5106b472d4e6bc90510c7b47d1468452b30f93ab6867de890bfa934ef473a52e27a21f9e8c32cbd4d465776ed154d08e93bdac9994af7b1dbb8e25255c7e8be7a6ecb77a96a247f951fb674aaf2609a91c1694da9f1e9ac00674e7b0e49c707c8ddb1868cdac4fdace13e255b6369d4dea2ceaab6974ccb952a8c97ca2c691215a36971aeb3567a56ab99d6f4b686e15cf4dcd6391c6bb36d61f0373937273c0a73ab1a11f832bf8b8275f17d1f228ee214854db6283f296d05bb987a7a197b691961fc96ff50c49fe6780bcace7f3f9f7fbbfc3ebedf7479146b5b517a0b2c69ecf7f0076e006f628050000",
        ],
        [
          "Date",
          "Wed, 15 Feb 2023 14:37:50 GMT",
          "Content-Type",
          "application/json; charset=utf-8",
          "Content-Length",
          "876",
          "Connection",
          "close",
          "Set-Cookie",
          "AWSALB=O7TbAoUMej9JmAuoqP/vhMUUqR0OUUqbOv12j5v6earZyBzS3SLlJzUgPllysbbYx0qBBzN2mD286ltgmM+SNEsvQgPh+1a5tlSPKFjmA25BLz0gAVUmrrub8DjZ; Expires=Wed, 22 Feb 2023 14:37:50 GMT; Path=/",
          "Set-Cookie",
          "AWSALBCORS=O7TbAoUMej9JmAuoqP/vhMUUqR0OUUqbOv12j5v6earZyBzS3SLlJzUgPllysbbYx0qBBzN2mD286ltgmM+SNEsvQgPh+1a5tlSPKFjmA25BLz0gAVUmrrub8DjZ; Expires=Wed, 22 Feb 2023 14:37:50 GMT; Path=/; SameSite=None; Secure",
          "Server",
          "Tengine",
          "Set-Cookie",
          "brw=brwRsIXvrjFGx5V8F; path=/; expires=Thu, 15 Feb 2024 14:37:50 GMT; domain=.airtable.com; samesite=none; secure",
          "Strict-Transport-Security",
          "max-age=31536000; includeSubDomains; preload",
          "access-control-allow-origin",
          "*",
          "access-control-allow-methods",
          "DELETE,GET,OPTIONS,PATCH,POST,PUT",
          "access-control-allow-headers",
          "authorization,content-length,content-type,user-agent,x-airtable-application-id,x-airtable-user-agent,x-api-version,x-requested-with",
          "X-Frame-Options",
          "DENY",
          "X-Content-Type-Options",
          "nosniff",
          "Vary",
          "Accept-Encoding",
          "content-encoding",
          "gzip",
          "airtable-uncompressed-content-length",
          "1320",
        ]
      );

    const accessToken = authToken();

    const data = await endpoints.getRecord.request({
      parameters: {
        baseId: "appBlf3KsalIQeMUo",
        tableIdOrName: "tblvXn2TOeVPC9c6m",
        recordId: "recHcnB1MbBr9Rd2P",
      },
      credentials: {
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: ["data.records:read"],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.body).not.toBeNull();
  });
});
