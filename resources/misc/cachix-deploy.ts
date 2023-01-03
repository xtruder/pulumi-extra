import * as pulumi from "@pulumi/pulumi";
import { local } from "@pulumi/command";

interface CachixDeployArgs {
  flakePath: pulumi.Input<string>;
  cacheName: pulumi.Input<string>;
  activateToken: pulumi.Input<string>;
  agentName: pulumi.Input<string>;
}

export class CachixDeploy extends pulumi.ComponentResource {
  public deployment: pulumi.Output<string>;

  constructor(name: string, args: CachixDeployArgs, opts?: pulumi.ComponentResourceOptions) {
    super("pulumi-extra:misc:CachixDeploy", name, {}, opts);

    const defaultResourceOptions: pulumi.ResourceOptions = { parent: this };

    let {
      flakePath,
      cacheName,
      activateToken,
      agentName
    } = args;

    const buildResult = new local.Command(`${name}-nix-build`, {
      create: pulumi.interpolate`nix build --print-out-paths --impure ${flakePath}`,
      update: pulumi.interpolate`nix build --print-out-paths --impure ${flakePath}`,
    }, defaultResourceOptions);

    new local.Command(`${name}-cachix-push`, {
      create: pulumi.interpolate`cachix push ${cacheName} ${buildResult.stdout}`,
      update: pulumi.interpolate`cachix push ${cacheName} ${buildResult.stdout}`,
      triggers: [buildResult.stdout]
    }, defaultResourceOptions);

    const cachixDeployActivate = new local.Command(`${name}-cacix-deploy-activate`, {
      create: pulumi.interpolate`cachix deploy activate ${buildResult.stdout} -a ${agentName}`,
      update: pulumi.interpolate`cachix deploy activate ${buildResult.stdout} -a ${agentName}`,
      environment: {
        CACHIX_ACTIVATE_TOKEN: pulumi.secret(activateToken)
      },
      triggers: [buildResult.stdout]
    }, defaultResourceOptions);

    this.deployment = cachixDeployActivate.stdout;
  }
}
