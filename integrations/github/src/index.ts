import { clientFactory } from "./client";
import { metadata } from "./metadata";
import { createIssue, createIssueComment, getRepo } from "./tasks";
import { onIssueOpened } from "./triggers";

export const github = {
  metadata,
  clientFactory,
  onIssueOpened,
  tasks: {
    createIssue,
    createIssueComment,
    getRepo,
  },
};
