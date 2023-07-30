﻿// Copyright (c) Martin Costello, 2020. All rights reserved.
// Licensed under the Apache 2.0 license. See the LICENSE file in the project root for full license information.

import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';

import { DotNetSdkUpdater } from './DotNetSdkUpdater';
import { UpdateOptions } from './UpdateOptions';
import { Context } from '@actions/github/lib/context';

export async function run(): Promise<void> {
  try {
    const accessToken = core.getInput('repo-token', { required: true });
    const globalJsonFileName = core.getInput('global-json-file', {
      required: true,
    });

    let globalJsonPath = path.normalize(globalJsonFileName);
    globalJsonPath = path.resolve(globalJsonPath);

    if (!fs.existsSync(globalJsonPath)) {
      core.setFailed(`The global.json file '${globalJsonPath}' cannot be found.`);
      return;
    }

    const context = new Context();

    const options: UpdateOptions = {
      accessToken,
      apiUrl: context.apiUrl,
      branch: core.getInput('branch-name', { required: false }),
      channel: core.getInput('channel', { required: false }),
      commitMessage: core.getInput('commit-message', { required: false }),
      commitMessagePrefix: core.getInput('commit-message-prefix', { required: false }),
      dryRun: core.getInput('dry-run', { required: false }) === 'true',
      generateStepSummary: core.getInput('generate-step-summary', { required: false }) === 'true',
      globalJsonPath,
      labels: core.getInput('labels', { required: false }) ?? '',
      quality: core.getInput('quality', { required: false }),
      repo: process.env.GITHUB_REPOSITORY,
      runId: context.runId.toString(10),
      serverUrl: context.serverUrl,
      userEmail: core.getInput('user-email', { required: false }),
      userName: core.getInput('user-name', { required: false }),
    };

    const updater = new DotNetSdkUpdater(options);
    const result = await updater.tryUpdateSdk();

    core.setOutput('branch-name', result.branchName);
    core.setOutput('pull-request-number', result.pullRequestNumber);
    core.setOutput('pull-request-html-url', result.pullRequestUrl);
    core.setOutput('sdk-updated', result.updated);
    core.setOutput('sdk-version', result.version);
    core.setOutput('security', result.security);
  } catch (error: any) {
    core.error('Failed to check for updates to .NET SDK');
    core.error(error);
    if (error instanceof Error) {
      core.setFailed(error.message);
    }
  }
}

if (require.main === module) {
  run();
}
