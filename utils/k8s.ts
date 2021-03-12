import * as path from 'path';

import * as pulumi from '@pulumi/pulumi';
import * as k8sClient from '@kubernetes/client-node';
import * as k8s from "@pulumi/kubernetes";
import * as request from 'request-promise';

// removes kubernetes resource if it matches condition
export function removeK8SResourceCondition(condition: (obj: any) => boolean) {
    return (obj: any) => {
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
    read:
        ((api: T, name: string) => Promise<{body: R} | undefined>) |
        ((api: T, name: string, namespace: string) => Promise<{body: R} | undefined>),
    resource?: pulumi.Resource
}): pulumi.Output<R | undefined> {
    const kubeConfig = pulumi.output<pulumi.Output<string>>((provider as any).kubeconfig);

    return pulumi.all([kubeConfig, namespace, name, resource]).apply(
        async ([kubeConfig, namespace, name, resource]) => {
            const kc = getKubeconfig(kubeConfig);
            const api = kc.makeApiClient<T>(apiType);

            let counter = 0;
            while (true) {
                try {
                    if (counter > 0) {
                        pulumi.log.info(`Waiting for ${kind} "${namespace}/${name}" ...`, resource);
                    }

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

                counter++;
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

export function waitK8SDeployment(
    namespace: pulumi.Input<string>,
    name: pulumi.Input<string>,
    provider: k8s.Provider,
    resource?: pulumi.Resource
) {
    return waitK8SResource({
        namespace,
        name,
        kind: "deployment",
        provider,
        resource,
        apiType: k8sClient.AppsV1Api,
        read: async (api, name, namespace) => {
            const result = await api.readNamespacedDeployment(name, namespace);

            // if there are any ready ready replicas, continue
            if ((result.body.status?.readyReplicas || 0) > 0) {
                return result;
            }

            return;
        }
    });
}

interface CustomResource {
    apiVersion: pulumi.Input<string>;
    metadata: {
        namespace?: pulumi.Input<string>;
        name: pulumi.Input<string>;
    };
}

export interface CustomResourceWithBody extends CustomResource {
    body: pulumi.Output<any>;
}

export function waitK8SCustomResourceCondition<C extends CustomResource, R extends pulumi.Resource>(
    customResource: C,
    resourceName: pulumi.Input<string>,
    check: (v: any) => boolean,
    provider: k8s.Provider,
    resource?: R,
): C & {body: pulumi.Output<any>} {
    const kubeConfig = pulumi.output<pulumi.Output<string>>((provider as any).kubeconfig);

    let logResource = resource ? resource : customResource as any as R;

    return pulumi.all([kubeConfig, customResource.apiVersion, resourceName, customResource.metadata.namespace, customResource.metadata.name]).apply(
        async ([kubeConfig, apiVersion, resourceName, namespace, name]) => {
            const kc = getKubeconfig(kubeConfig);
            const server = kc.getCurrentCluster()?.server; 

            const opts = { json: true };
            kc.applyToRequest(opts as any);

            let counter = 0;
            while (true) {
                try {
                    if (counter > 0) {
                        pulumi.log.info(`Waiting for ${resourceName} "${namespace ? `${namespace}/` : ""}${name}" ...`, logResource);
                    }

                    let url: string;

                    // whether resource is namespaced or not
                    if (namespace) {
                        url = `${server}/apis/${apiVersion}/namespaces/${namespace}/${resourceName}/${name}`;
                    } else {
                        url = `${server}/apis/${apiVersion}/${resourceName}/${name}`;
                    }

                    const body = await request.get(url, opts);

                    pulumi.log.debug(`Resource ${resourceName} "${namespace ? `${namespace}/` : ""}${name}": `+JSON.stringify(body), logResource)

                    // if check passes return result
                    if (check(body)) {
                        return {...customResource, body};
                    }
                } catch (err) {
                    // if is dry run assume if error, resource is missing, so ignore it,
                    // as this is only preview, real values will be resolved later
                    if (pulumi.runtime.isDryRun()) {
                        pulumi.log.info(`Error getting resource: ` + err, logResource);
                        return {...customResource, body: pulumi.output(undefined)};
                    }

                    pulumi.log.warn(`Error requesting ${resourceName} "${namespace ? `${namespace}/` : ""}${name}: ` + err?.message, logResource)
                }

                counter ++;
                await new Promise(r => setTimeout(r, 2000));
            }
        }) as any;
}