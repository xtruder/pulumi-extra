import * as pulumi from "@pulumi/pulumi";
import { local } from "@pulumi/command";

import { CachixDeploy } from "../../providers/cachix-deploy";

interface NixOSCachixDeployArgs {
  flakePath: pulumi.Input<string>;
  agentName: pulumi.Input<string>;
  cacheName: pulumi.Input<string>;
  workspaceName: pulumi.Input<string>;
  authToken: pulumi.Input<string>;
  activationToken: pulumi.Input<string>;
}

export class NixOSCachixDeploy extends pulumi.ComponentResource {
  public storePath: pulumi.Output<string>;

  constructor(
    name: string,
    args: NixOSCachixDeployArgs,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("pulumi-extra:misc:CachixDeploy", name, {}, opts);

    const defaultResourceOptions: pulumi.ResourceOptions = { parent: this };

    let {
      flakePath,
      workspaceName,
      agentName,
      cacheName,
      authToken,
      activationToken,
    } = args;

    const buildResult = new local.Command(
      `${name}-nix-build`,
      {
        create: pulumi.interpolate`nix build --print-out-paths --no-link --impure ${flakePath} 2>/dev/null`,
        triggers: [new Date().toISOString()],
      },
      defaultResourceOptions
    );

    const cachixPush = new local.Command(
      `${name}-cachix-push`,
      {
        create: pulumi.interpolate`cachix push ${cacheName} ${buildResult.stdout} 2>/dev/null`,
        triggers: [buildResult.stdout],
      },
      defaultResourceOptions
    );

    const result = new CachixDeploy(
      name,
      {
        agentName,
        storePath: buildResult.stdout,
        workspaceName,
        authToken,
        activationToken,
      },
      {
        ...defaultResourceOptions,
        dependsOn: [cachixPush],
      }
    );

    this.storePath = result.storePath;
  }
}
