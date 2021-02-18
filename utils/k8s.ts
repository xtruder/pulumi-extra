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

type ApiConstructor<T extends k8sClient.ApiType> = new (server: string) => T;

export function waitK8SResource<T extends k8sClient.ApiType, R>({
    namespace,
    name,
    kind,
    provider,
    apiType,
    read,
    resource
}: {
    namespace?: pulumi.Input<string>,
    name: pulumi.Input<string>,
    kind: string,
    provider?: k8s.Provider,
    apiType: ApiConstructor<T>,
    read: (api: T, name: string, namespace?: string) => Promise<{body: R}> | undefined,
    resource?: pulumi.Resource
}): pulumi.Output<R> {
    const kubeConfig = (provider as any).kubeconfig as pulumi.Output<string>;

    return pulumi.all([kubeConfig, namespace, name, resource]).apply(
        async ([kubeConfig, namespace, name, resource]) => {
            const kc = getKubeconfig(kubeConfig);
            const api = kc.makeApiClient<T>(apiType);

            while (true) {
                try {
                    pulumi.log.debug(`Waiting for ${kind} "${namespace}/${name}" ...`, resource);

                    let result = await read(api, name, namespace);

                    if (!result) {
                        continue;
                    }

                    return result.body;
                } catch (err) {
                    if (pulumi.runtime.isDryRun()) {
                        return;
                    }

                    pulumi.log.warn(`error requesting k8s ${kind} "${namespace ? `${namespace}/${name}`: name}": ` + err?.message, resource)
                }

                await new Promise(r => setTimeout(r, 2000));
            }
        }
    );
}

export function waitK8SService(
    namespace: pulumi.Input<string>,
    name: pulumi.Input<string>,
    provider: k8s.Provider,
    resource?: pulumi.Resource
) {
    return waitK8SResource({
        namespace,
        name,
        kind: "service",
        provider,
        resource,
        apiType: k8sClient.CoreV1Api,
        read: (api, name, namespace) => api.readNamespacedService(name, namespace)
    });
}

export function waitK8SSecret(
    namespace: pulumi.Input<string>,
    name: pulumi.Input<string>,
    provider: k8s.Provider,
    resource?: pulumi.Resource
) {
    return waitK8SResource({
        namespace,
        name,
        kind: "secret",
        provider,
        resource,
        apiType: k8sClient.CoreV1Api,
        read: (api, name, namespace) => api.readNamespacedSecret(name, namespace)
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
                    pulumi.log.debug(`Waiting for ${resourceName} "${namespace}/${name}" ...`, resource);

                    const url = `${kc.getCurrentCluster()?.server}/apis/${apiVersion}/namespaces/${namespace}/${resourceName}/${name}`;
                    const body = await request.get(url, opts);

                    if (check(body)) {
                        return resource;
                    }
                } catch (err) {
                    pulumi.log.warn(`error requesting ${resourceName} "${namespace}/${name}: ` + err?.message, resource)
                }

                await new Promise(r => setTimeout(r, 2000));
            }
        }) as any;
}