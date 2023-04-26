// Copyright (c) Martin Costello, 2020. All rights reserved.
// Licensed under the Apache 2.0 license. See the LICENSE file in the project root for full license information.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';

import { HttpClient } from '@actions/http-client';
import { UpdateOptions } from './UpdateOptions';
import { UpdateResult } from './UpdateResult';
import { Writable } from 'stream';

export class DotNetSdkUpdater {
  private options: UpdateOptions;
  private repoPath: string;

  constructor(options: UpdateOptions) {
    this.options = options;
    this.repoPath = path.dirname(this.options.globalJsonPath);
  }

  public static getLatestRelease(currentSdkVersion: string, channel: ReleaseChannel): SdkVersions {
    const current = DotNetSdkUpdater.getReleaseForSdk(currentSdkVersion, channel);
    const latest = DotNetSdkUpdater.getReleaseForSdk(channel['latest-sdk'], channel);

    const result = {
      current,
      latest,
      security: latest.security,
      securityIssues: latest.securityIssues,
    };

    const currentParts = current.runtimeVersion.split('.');
    const latestParts = latest.runtimeVersion.split('.');

    const versionMajor = parseInt(currentParts[0], 10);
    const versionMinor = parseInt(currentParts[1], 10);

    // Do not attempt to compute the patch delta if either SDK version is a preview
    if (!currentParts[2].includes('-') && !latestParts[2].includes('-')) {
      const currentPatch = parseInt(currentParts[2], 10);
      const latestPatch = parseInt(latestParts[2], 10);

      const patchDelta = latestPatch - currentPatch;

      if (patchDelta > 1) {
        for (let patch = currentPatch; patch < latestPatch; patch++) {
          const version = `${versionMajor}.${versionMinor}.${patch}`;
          const release = channel.releases.find((p) => p.runtime.version === version);
          if (release) {
            result.security = result.security || release.security;
            if (release['cve-list']) {
              result.securityIssues = result.securityIssues.concat(DotNetSdkUpdater.mapCves(release['cve-list']));
            }
          }
        }
      }
    }

    result.securityIssues.sort((a, b) => a.id.localeCompare(b.id));

    return result;
  }

  public static generateCommitMessage(currentSdkVersion: string, latestSdkVersion: string): string {
    const currentVersion = currentSdkVersion.split('.');
    const latestVersion = latestSdkVersion.split('.');

    const updateKind =
      parseInt(latestVersion[0], 10) > parseInt(currentVersion[0], 10)
        ? 'major'
        : parseInt(latestVersion[1], 10) > parseInt(currentVersion[1], 10)
        ? 'minor'
        : 'patch';

    const messageLines = [
      'Update .NET SDK',
      '',
      `Update .NET SDK to version ${latestSdkVersion}.`,
      '',
      '---',
      'updated-dependencies:',
      '- dependency-name: Microsoft.NET.Sdk',
      '  dependency-type: direct:production',
      `  update-type: version-update:semver-${updateKind}`,
      '...',
      '',
      '',
    ];
    return messageLines.join('\n');
  }

  public static generatePullRequestBody(update: SdkVersions, options: UpdateOptions): string {
    let body = `Updates the .NET SDK to version \`${update.latest.sdkVersion}\`, `;

    if (update.latest.runtimeVersion === update.current.runtimeVersion) {
      body += `which includes version [\`\`${update.latest.runtimeVersion}\`\`](${update.latest.releaseNotes}) of the .NET runtime.`;
    } else {
      body += `which also updates the .NET runtime from version [\`\`${update.current.runtimeVersion}\`\`](${update.current.releaseNotes}) to version [\`\`${update.latest.runtimeVersion}\`\`](${update.latest.releaseNotes}).`;
    }

    if (update.security && update.securityIssues.length > 0) {
      body += `\n\nThis release includes fixes for the following security issue(s):`;
      for (const issue of update.securityIssues) {
        body += `\n  * [${issue.id}](${issue.url})`;
      }
    }

    body += `\n\nThis pull request was auto-generated by [GitHub Actions](${options.serverUrl}/${options.repo}/actions/runs/${options.runId}).`;

    return body;
  }

  public async tryUpdateSdk(): Promise<UpdateResult> {
    const globalJson: GlobalJson = JSON.parse(fs.readFileSync(this.options.globalJsonPath, { encoding: 'utf8' }));

    let sdkVersion = '';

    if (globalJson.sdk && globalJson.sdk.version) {
      sdkVersion = globalJson.sdk.version;
    }

    if (!sdkVersion) {
      throw new Error(`.NET SDK version cannot be found in '${this.options.globalJsonPath}'.`);
    }

    if (!this.options.channel) {
      const versionParts = sdkVersion.split('.');

      if (versionParts.length < 2) {
        throw new Error(`.NET SDK version '${sdkVersion}' is not valid.`);
      }

      this.options.channel = `${versionParts[0]}.${versionParts[1]}`;
    }

    const releaseChannel = await this.getDotNetReleaseChannel(this.options.channel);
    const update = DotNetSdkUpdater.getLatestRelease(sdkVersion, releaseChannel);

    const result: UpdateResult = {
      pullRequestNumber: 0,
      pullRequestUrl: '',
      updated: false,
      security: false,
      version: update.current.sdkVersion,
    };

    core.info(`Current .NET SDK version is ${update.current.sdkVersion}`);
    core.info(`Current .NET runtime version is ${update.current.runtimeVersion}`);
    core.info(
      `Latest .NET SDK version for channel '${this.options.channel}' is ${update.latest.sdkVersion} (runtime version ${update.latest.runtimeVersion})`
    );

    if (update.current.sdkVersion !== update.latest.sdkVersion) {
      const baseBranch = await this.applySdkUpdate(globalJson, update);

      if (baseBranch) {
        const pullRequest = await this.createPullRequest(baseBranch, update);
        result.pullRequestNumber = pullRequest.number;
        result.pullRequestUrl = pullRequest.url;

        result.security = update.security;
        result.updated = true;
        result.version = update.latest.sdkVersion;
      }
    } else {
      core.info('The current .NET SDK version is up-to-date');
    }

    return result;
  }

  private async createPullRequest(base: string, update: SdkVersions): Promise<PullRequest> {
    const title = `Update .NET SDK to ${update.latest.sdkVersion}`;
    const body = DotNetSdkUpdater.generatePullRequestBody(update, this.options);

    const options = {
      baseUrl: this.options.apiUrl,
    };

    const octokit = github.getOctokit(this.options.accessToken, options);

    const split = (this.options.repo ?? '/').split('/');
    const owner = split[0];
    const repo = split[1];

    const request = {
      owner,
      repo,
      title,
      head: this.options.branch,
      base,
      body,
      maintainer_can_modify: true,
      draft: false,
    };

    if (this.options.dryRun) {
      core.info(`Skipped creating GitHub Pull Request for branch ${this.options.branch} to ${base}`);
      return {
        number: 0,
        url: '',
      };
    }

    const response = await octokit.rest.pulls.create(request);

    core.debug(JSON.stringify(response, null, 2));

    core.info(`Created pull request #${response.data.number}: ${response.data.title}`);
    core.info(`View the pull request at ${response.data.html_url}`);

    const result = {
      number: response.data.number,
      url: response.data.html_url,
    };

    if (this.options.labels) {
      const labelsToApply = this.options.labels.split(',');

      if (labelsToApply.length > 0) {
        try {
          await octokit.rest.issues.addLabels({
            owner,
            repo,
            issue_number: result.number,
            labels: labelsToApply,
          });
        } catch (error: any) {
          core.error(`Failed to apply label(s) to Pull Request #${result.number}`);
          core.error(error);
        }
      }
    }

    return result;
  }

  private async execGit(args: string[], ignoreErrors: Boolean = false): Promise<string> {
    let commandOutput = '';
    let commandError = '';

    const options = {
      cwd: this.repoPath,
      errStream: new NullWritable(),
      outStream: new NullWritable(),
      ignoreReturnCode: ignoreErrors as boolean | undefined,
      silent: ignoreErrors as boolean | undefined,
      listeners: {
        stdout: (data: Buffer) => {
          commandOutput += data.toString();
        },
        stderr: (data: Buffer) => {
          commandError += data.toString();
        },
      },
    };

    try {
      await exec.exec('git', args, options);
    } catch (error: any) {
      throw new Error(`The command 'git ${args.join(' ')}' failed: ${error}`);
    }

    if (commandError && !ignoreErrors) {
      throw new Error(commandError);
    }

    core.debug(`git std-out: ${commandOutput}`);

    if (commandError) {
      core.debug(`git std-err: ${commandError}`);
    }

    return commandOutput.trimEnd();
  }

  private async getDotNetReleaseChannel(channel: string): Promise<ReleaseChannel> {
    const httpClient = new HttpClient('martincostello/update-dotnet-sdk', [], {
      allowRetries: true,
      maxRetries: 3,
    });

    const releasesUrl = `https://raw.githubusercontent.com/dotnet/core/main/release-notes/${channel}/releases.json`;

    core.debug(`Downloading .NET ${channel} release notes JSON from ${releasesUrl}...`);

    const response = await httpClient.getJson<ReleaseChannel>(releasesUrl);

    if (response.statusCode >= 400) {
      throw new Error(`Failed to get releases JSON for channel ${channel} - HTTP status ${response.statusCode}`);
    } else if (!response.result) {
      throw new Error(`Failed to get releases JSON for channel ${channel}.`);
    }

    return response.result;
  }

  private static getReleaseForSdk(sdkVersion: string, channel: ReleaseChannel): ReleaseInfo {
    let releasesForSdk = channel.releases.filter((info: Release) => info.sdk.version === sdkVersion);
    let foundSdk: Sdk | null = null;

    if (releasesForSdk.length === 1) {
      foundSdk = releasesForSdk[0].sdk;
    } else if (releasesForSdk.length < 1) {
      releasesForSdk = channel.releases.filter((info: Release) => {
        if (info.sdks !== null) {
          for (const sdk of info.sdks) {
            if (sdk.version === sdkVersion) {
              foundSdk = sdk;
              return true;
            }
          }
        }
        return false;
      });
    }

    if (releasesForSdk.length < 1 || !foundSdk) {
      throw new Error(`Failed to find release for .NET SDK version ${sdkVersion}`);
    }

    const release = releasesForSdk[0];

    const result = {
      releaseNotes: release['release-notes'],
      runtimeVersion: release.runtime.version,
      sdkVersion: foundSdk.version,
      security: release.security,
      securityIssues: [] as CveInfo[],
    };

    if (result.security) {
      const issues = release['cve-list'];
      if (issues) {
        result.securityIssues = DotNetSdkUpdater.mapCves(issues);
      }
    }

    return result;
  }

  private static mapCves(cves: Cve[]): CveInfo[] {
    return cves.map((issue: Cve) => ({
      id: issue['cve-id'],
      url: issue['cve-url'],
    }));
  }

  private async applySdkUpdate(globalJson: GlobalJson, versions: SdkVersions): Promise<string | undefined> {
    core.info(`Updating .NET SDK version in '${this.options.globalJsonPath}' to ${versions.latest.sdkVersion}...`);

    // Get the base branch to use later to create the Pull Request
    const base = await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD']);

    // Apply the update to the file system
    globalJson.sdk.version = versions.latest.sdkVersion;
    const json = JSON.stringify(globalJson, null, 2) + os.EOL;

    fs.writeFileSync(this.options.globalJsonPath, json, { encoding: 'utf8' });
    core.info(`Updated SDK version in '${this.options.globalJsonPath}' to ${versions.latest.sdkVersion}`);

    // Configure Git
    if (!this.options.branch) {
      this.options.branch = `update-dotnet-sdk-${versions.latest.sdkVersion}`.toLowerCase();
    }

    if (!this.options.commitMessage) {
      this.options.commitMessage = DotNetSdkUpdater.generateCommitMessage(versions.current.sdkVersion, versions.latest.sdkVersion);
    }

    if (this.options.userName) {
      await this.execGit(['config', 'user.name', this.options.userName]);
      core.info(`Updated git user name to '${this.options.userName}'`);
    }

    if (this.options.userEmail) {
      await this.execGit(['config', 'user.email', this.options.userEmail]);
      core.info(`Updated git user email to '${this.options.userEmail}'`);
    }

    if (this.options.repo) {
      await this.execGit(['remote', 'set-url', 'origin', `${this.options.serverUrl}/${this.options.repo}.git`]);
      await this.execGit(['fetch', 'origin'], true);
    }

    core.debug(`Branch: ${this.options.branch}`);
    core.debug(`Commit message: ${this.options.commitMessage}`);
    core.debug(`User name: ${this.options.userName}`);
    core.debug(`User email: ${this.options.userEmail}`);

    const branchExists = await this.execGit(['rev-parse', '--verify', '--quiet', `remotes/origin/${this.options.branch}`], true);

    if (branchExists) {
      core.info(`The ${this.options.branch} branch already exists`);
      return undefined;
    }

    await this.execGit(['checkout', '-b', this.options.branch], true);
    core.info(`Created git branch ${this.options.branch}`);

    await this.execGit(['add', this.options.globalJsonPath]);
    core.info(`Staged git commit for '${this.options.globalJsonPath}'`);

    await this.execGit(['commit', '-m', this.options.commitMessage, '-s']);

    const sha1 = await this.execGit(['log', "--format='%H'", '-n', '1']);
    const shortSha1 = sha1.replace(/'/g, '').substring(0, 7);

    core.info(`Committed .NET SDK update to git (${shortSha1})`);

    if (!this.options.dryRun && this.options.repo) {
      await this.execGit(['push', '-u', 'origin', this.options.branch], true);
      core.info(`Pushed changes to repository (${this.options.repo})`);
    }

    return base;
  }
}

interface CveInfo {
  id: string;
  url: string;
}

interface PullRequest {
  number: number;
  url: string;
}

interface ReleaseInfo {
  releaseNotes: string;
  runtimeVersion: string;
  sdkVersion: string;
  security: boolean;
  securityIssues: CveInfo[];
}

interface SdkVersions {
  current: ReleaseInfo;
  latest: ReleaseInfo;
  security: boolean;
  securityIssues: CveInfo[];
}

interface ReleaseChannel {
  'channel-version': string;
  'latest-release': string;
  'latest-release-date': string;
  'latest-runtime': string;
  'latest-sdk': string;
  'release-type': string;
  'support-phase': string;
  'eol-date"': string;
  'lifecycle-policy"': string;
  'releases': Release[];
}

interface Release {
  'release-date': string;
  'release-version': string;
  'security': boolean;
  'cve-list': Cve[];
  'release-notes': string;
  'runtime': Runtime;
  'sdk': Sdk;
  'sdks': Sdk[];
  'aspnetcore-runtime': Runtime;
}

interface Runtime {
  'version': string;
  'version-display': string;
}

interface Sdk {
  'version': string;
  'version-display': string;
  'runtime-version': string;
}

interface Cve {
  'cve-id': string;
  'cve-url': string;
}

interface GlobalJson {
  sdk: {
    version: string;
  };
}

class NullWritable extends Writable {
  _write(_chunk: any, _encoding: string, callback: (error?: Error | null) => void): void {
    callback();
  }
  _writev(_chunks: { chunk: any; encoding: string }[], callback: (error?: Error | null) => void): void {
    callback();
  }
}
