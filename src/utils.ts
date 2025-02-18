import { Octokit } from "@octokit/rest";
import { setOutput, info, getInput, warning } from "@actions/core";

import fetch, { Response } from "node-fetch";
import moment from "moment";
import yaml from "yaml";

import { WebhookBody, PotentialAction } from "./models";
import { formatCompactLayout } from "./layouts/compact";
import { formatCozyLayout } from "./layouts/cozy";
import { formatCompleteLayout } from "./layouts/complete";
import { CONCLUSION_THEMES } from "./constants";

export function escapeMarkdownTokens(text: string) {
  return text
    .replace(/\n\ {1,}/g, "\n ")
    .replace(/\_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/\|/g, "\\|")
    .replace(/#/g, "\\#")
    .replace(/-/g, "\\-")
    .replace(/>/g, "\\>");
}

export function getRunInformation() {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/");
  const githubHost = getInput("github-enterprise-host", { required: false });
  return {
    owner,
    repo,
    ref: process.env.GITHUB_SHA || undefined,
    branchUrl: `https://${githubHost}/${process.env.GITHUB_REPOSITORY}/tree/${process.env.GITHUB_REF}`,
    runId: process.env.GITHUB_RUN_ID || undefined,
    runNum: process.env.GITHUB_RUN_NUMBER || undefined,
  };
}

export async function getOctokitCommit() {
  const runInfo = getRunInformation();
  info("Workflow run information: " + JSON.stringify(runInfo, undefined, 2));

  const githubToken = getInput("github-token", { required: true });
  const octokit = new Octokit({ auth: `token ${githubToken}` });
  
  return await octokit.repos.getCommit({
    owner: runInfo.owner,
    repo: runInfo.repo,
    ref: runInfo.ref || "",
  });
}

export function submitNotification(webhookBody: WebhookBody) {
  const webhookUri = getInput("webhook-uri", { required: true });
  const webhookBodyJson = JSON.stringify(webhookBody, undefined, 2);

  return fetch(webhookUri, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: webhookBodyJson,
  })
    .then(response => {
      setOutput("webhook-body", webhookBodyJson);
      info(webhookBodyJson);
      return response;
    })
    .catch(console.error);
}

export async function formatAndNotify(
  state: "start" | "exit",
  conclusion = "in_progress",
  elapsedSeconds?: number
) {
  console.log("inside formatAndNotify");
  let webhookBody: WebhookBody;
  const commit = await getOctokitCommit();
  const cardLayoutStart = getInput(`card-layout-${state}`);

  if (cardLayoutStart === "compact") {
    webhookBody = formatCompactLayout(commit, conclusion, elapsedSeconds);
  } else if (cardLayoutStart === "cozy") {
    webhookBody = formatCozyLayout(commit, conclusion, elapsedSeconds);
  } else {
    webhookBody = formatCompleteLayout(commit, conclusion, elapsedSeconds);
  }

  submitNotification(webhookBody);
}

export async function getWorkflowRunStatus() {
  const runInfo = getRunInformation();
  const githubToken = getInput("github-token", { required: true });
  const octokit = new Octokit({ auth: `token ${githubToken}` });
  info("run info: " + JSON.stringify(runInfo, undefined, 2));
  const currentJob = getInput("job-name", { required: false });
  info(" current job name == " + currentJob);
  const parentJob = getInput("parent-job", { required: false });
  info(" parent job name == " + parentJob);


  try {
    const workflowJobs = await octokit.actions.listJobsForWorkflowRun({
      owner: runInfo.owner,
      repo: runInfo.repo,
      run_id: parseInt(runInfo.runId || "1"),
    });
    info("Workflow jobs: " + JSON.stringify(workflowJobs, undefined, 2));

    info("current env vars == " + JSON.stringify(process.env, undefined, 2));
    // const currentJob = await octokit.actions.getJobForWorkflowRun({
    //   owner: runInfo.owner,
    //   repo: runInfo.repo,
    //   job_id: process.env.GITHUB_JOB
    // });
    const currentJobName = currentJob == "" ? process.env.GITHUB_JOB : currentJob

    const jobName = parentJob == "" ? currentJobName : parentJob + " / " + currentJobName

    const job = workflowJobs.data.jobs.find(
      (job: Octokit.ActionsListJobsForWorkflowRunResponseJobsItem) =>
        job.name === jobName
    );
    console.log("printing job");
      console.log(job);
    let lastStep;
    const stoppedStep = job?.steps.find(
      (step: Octokit.ActionsListJobsForWorkflowRunResponseJobsItemStepsItem) =>
        step.conclusion === "failure" ||
        step.conclusion === "timed_out" ||
        step.conclusion === "cancelled" ||
        step.conclusion === "action_required"
    );

    if (stoppedStep) {
      lastStep = stoppedStep;
    } else {
      lastStep = job?.steps
        .reverse()
        .find(
          (
            step: Octokit.ActionsListJobsForWorkflowRunResponseJobsItemStepsItem
          ) => step.status === "completed"
        );
    }

    const startTime = moment(job?.started_at, moment.ISO_8601);
    const endTime = moment(lastStep?.completed_at, moment.ISO_8601);

    return {
      elapsedSeconds: endTime.diff(startTime, "seconds"),
      conclusion: lastStep?.conclusion,
    }

  } catch (error: any) {
    console.log(error.message);
  };

  return {
    elapsedSeconds: 0,
    conclusion: 'unknown',
  }

}

export function renderActions(statusUrl: string, diffUrl: string) {
  const actions: PotentialAction[] = [];
  if (getInput("enable-view-status-action").toLowerCase() === "true") {
    actions.push(
      new PotentialAction(getInput("view-status-action-text"), [statusUrl])
    );
  }
  if (getInput("enable-review-diffs-action").toLowerCase() === "true") {
    actions.push(
      new PotentialAction(getInput("review-diffs-action-text"), [diffUrl])
    );
  }

  // Set custom actions
  const customActions = getInput("custom-actions");
  if (customActions && customActions.toLowerCase() !== "null") {
    try {
      let customActionsCounter = 0;
      const customActionsList = yaml.parse(customActions);
      if (Array.isArray(customActionsList)) {
        (customActionsList as any[]).forEach((action) => {
          if (
            action.text !== undefined &&
            action.url !== undefined &&
            (action.url as string).match(/https?:\/\/\S+/g)
          ) {
            actions.push(new PotentialAction(action.text, [action.url]));
            customActionsCounter++;
          }
        });
      }
      info(`Added ${customActionsCounter} custom facts.`);
    } catch {
      warning("Invalid custom-actions value.");
    }
  }
  return actions;
}
