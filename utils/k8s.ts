import * as path from 'path';

import * as pulumi from '@pulumi/pulumi';
import * as k8sClient from '@kubernetes/client-node';
import * as k8s from "@pulumi/kubernetes";
import * as request from 'request-promise';

// removes kubernetes resource if it matches condition
export function removeK8SResourceCondition(condition: (obj: any) => boolean) {
    return obj => {
        if(condition(obj)) {
            obj.apiVersion = "v1";
            obj.kind = "List";
        }
    }
}

type ResourceParams = {
    namespace?: string;
    kind?: string;
    name?: string;
}

// removes kubernetes resource if it matches provided params
export function removeK8SResourceParams({namespace, kind, name}: ResourceParams, negate?: boolean) {
    return removeK8SResourceCondition(obj => {
        let result = (
            (namespace ? (obj.metadata?.namespace == namespace) : true) &&
            (kind ? (obj.kind == kind) : true) &&
            (name ? (obj.metadata?.name == name) : true)
        );

        if (negate) {
            return !result;
        }

        return result
    });
}

// includes kubernetes resource if it match provided params
export function includeK8SResourceParams(params: ResourceParams) {
    return removeK8SResourceParams(params, true)
}


export interface k8sResource extends pulumi.Resource {
    readonly apiVersion: pulumi.Output<string>;
    readonly kind: pulumi.Output<string>;
    readonly metadata: pulumi.Output<k8s.types.output.meta.v1.ObjectMeta>;
}

function getKubeconfig(kubeConfig: string): k8sClient.KubeConfig {
    const kc = new k8sClient.KubeConfig();

    if (kubeConfig === path.basename(kubeConfig)) {
        kc.loadFromString(kubeConfig);
    } else {
        kc.loadFromFile(kubeConfig);
    }


    return kc;
}

export function waitK8SServiceIP(
    namespace: pulumi.Input<string>,
    name: pulumi.Input<string>,
    provider: k8s.Provider
) {
    const kubeConfig = (provider as any).kubeconfig as pulumi.Output<string>;

    return pulumi.all([kubeConfig, namespace, name]).apply(
        async ([kubeConfig, namespace, name]) => {
            const kc = getKubeconfig(kubeConfig);
            const k8sApi = kc.makeApiClient(k8sClient.CoreV1Api);

            while (true) {
                try {
                    const { body } = await k8sApi.readNamespacedService(name, namespace);

                    if (body.spec?.clusterIP) {
                        return body.spec.clusterIP;
                    }
                } catch (err) {
                    pulumi.log.warn("error requesting service: " + err?.message)
                }

                await new Promise(r => setTimeout(r, 2000));
            }
        });
}

export function waitK8SCustomResourceCondition<T extends k8s.apiextensions.CustomResource>(
    resource: T,
    resourceName: pulumi.Input<string>,
    check: (v: any) => boolean,
    provider: k8s.Provider
): T {
    if (pulumi.runtime.isDryRun()) {
        return resource;
    }

    const kubeConfig = (provider as any).kubeconfig as pulumi.Output<string>;

    return pulumi.all([kubeConfig, resource.apiVersion, resourceName, resource.metadata.namespace, resource.metadata.name]).apply(
        async ([kubeConfig, apiVersion, resourceName, namespace, name]) => {
            const kc = getKubeconfig(kubeConfig);

            const opts = { json: true };
            kc.applyToRequest(opts as any);

            while (true) {
                try {
                    pulumi.log.info('Waiting for resource...', resource);

                    const url = `${kc.getCurrentCluster()?.server}/apis/${apiVersion}/namespaces/${namespace}/${resourceName}/${name}`;
                    const body = await request.get(url, opts);

                    if (check(body)) {
                        return resource;
                    }
                } catch (err) {
                    pulumi.log.warn("error requesting resource: " + err?.message, resource)
                }

                await new Promise(r => setTimeout(r, 2000));
            }
        }) as any;
}