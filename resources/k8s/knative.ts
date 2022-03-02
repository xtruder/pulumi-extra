import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import { waitK8SCustomResourceCondition, CustomResource, removeK8SResourceParams } from '../../utils/k8s';

const
    version = "v0.21.0",
    servingCoreYAML = `https://github.com/knative/serving/releases/download/${version}/serving-core.yaml`,
    eventingCoreYAML = `https://github.com/knative/eventing/releases/download/${version}/eventing-core.yaml`,
    kourierYAML = `https://github.com/knative/net-kourier/releases/download/${version}/kourier.yaml`,
    servingDefaultDomain = `https://github.com/knative/serving/releases/download/${version}/serving-default-domain.yaml`,
    inMemoryChannelYAML = `https://github.com/knative/eventing/releases/download/${version}/in-memory-channel.yaml`,
    mtChannelBrokerYAML = `https://github.com/knative/eventing/releases/download/${version}/mt-channel-broker.yaml`;

function transformConfigs(configs: Record<string, pulumi.Input<any>>) {
    const camalize = (str: string) =>
        str.toLowerCase().replace(/[^a-zA-Z0-9]+(.)/g, (m, chr) => chr.toUpperCase());

    return (resource: any) => {
        if (resource.kind == "ConfigMap") {
            let normalized = camalize((resource.metadata.name as string).replace("config-", ""));
            if (normalized in configs && configs[normalized]) {
                resource.data = configs[normalized];
            }
        }
    }
}

type ConfigEntries = pulumi.Input<Record<string, pulumi.Input<string>>>;

type ServingConfig = {
    autoscaler?: ConfigEntries;
    defaults?: ConfigEntries;
    deployment?: ConfigEntries;
    domain?: ConfigEntries;
    features?: ConfigEntries;
    gc?: ConfigEntries;
    leaderElection?: ConfigEntries;
    logging?: ConfigEntries;
    network?: ConfigEntries;
    observability?: ConfigEntries;
    tracing?: ConfigEntries;
    defaultDomain?: pulumi.Input<boolean>;
};

type EventingConfig = {
    enable?: pulumi.Input<boolean>;
    inMemoryChannel?: {
        enable?: pulumi.Input<boolean>;
    };
    mtChannelBroker?: {
        enable?: pulumi.Input<boolean>;
    };

    brDefaultChannel?: ConfigEntries;
    brDefaults?: ConfigEntries;
    leaderElection?: ConfigEntries;
    logging?: ConfigEntries;
    observability?: ConfigEntries;
    pingDefaults?: ConfigEntries;
    tracing?: ConfigEntries;
};

type KourierConfig = {
    enable?: pulumi.Input<boolean>;
};

export interface KnativeArgs {
    serving?: ServingConfig;
    eventing?: EventingConfig;
    kourier?: KourierConfig;
}

export class Knative extends pulumi.ComponentResource {
    constructor(args?: KnativeArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:Knative", "knative", {}, opts);

        let {
            serving = {},
            eventing = {
                // eventing is disabled by default
                enable: false
            },
            kourier = {
                enable: true
            }
        } = args || {};

        let servingCore = pulumi.all(serving).apply((serving: pulumi.UnwrappedObject<ServingConfig>) => {
            let {
                defaultDomain = true
            } = serving;

            // if kourier is enabled set ingress.class for serving to kourier
            if (kourier.enable) {
                serving.network = {
                    "ingress.class": "kourier.ingress.networking.knative.dev",
                    ...serving.network
                };
            }

            // provision knative serving core
            let servingCore = new k8s.yaml.ConfigFile("knative-serving-core", {
                file: servingCoreYAML,
                transformations: [
                    transformConfigs(serving)
                ]
            }, { parent: this });

            if (defaultDomain) {
                // provision knative default domain
                new k8s.yaml.ConfigFile("knative-serving-default-domain", {
                    file: servingDefaultDomain
                }, { parent: this, dependsOn: [servingCore] });
            }

            return servingCore;
        });

        pulumi.all(eventing).apply((eventing: EventingConfig) => {
            if (!eventing.enable) {
                return;
            }

            let {
                inMemoryChannel = {
                    enable: true
                },
                mtChannelBroker = {
                    enable: true
                }
            } = eventing;

            // provision knative eventing core
            const eventingCore = new k8s.yaml.ConfigFile("knative-eventing-core", {
                file: eventingCoreYAML,
                transformations: [
                    transformConfigs(serving)
                ]
            }, { parent: this, dependsOn: [servingCore] });

            if (inMemoryChannel.enable) {
                new k8s.yaml.ConfigFile("knative-eventing-inmemory-channel", {
                    file: inMemoryChannelYAML,
                }, { parent: this, dependsOn: [eventingCore] });
            }

            if (mtChannelBroker.enable) {
                new k8s.yaml.ConfigFile("knative-eventing-mt-channel-broker", {
                    file: mtChannelBrokerYAML,
                }, { parent: this, dependsOn: [eventingCore] });
            }
        });

        pulumi.all(kourier).apply((kourier: KourierConfig) => {
            if (!kourier.enable) {
                return;
            }

            new k8s.yaml.ConfigFile("kourier", {
                file: kourierYAML
            }, { parent: this });
        });
    }
}

export function waitReady<T extends CustomResource>(service: T, provider: k8s.Provider) {
    return waitK8SCustomResourceCondition(service, (resource) => {
        for (const condition of resource?.status?.conditions || []) {
            if (condition?.type == "Ready" && condition?.status == "True") {
                return true;
            }
        }

        return false;
    }, provider);
}
