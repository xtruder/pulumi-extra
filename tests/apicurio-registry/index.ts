import * as k8s from '@pulumi/kubernetes';

import { apicurioRegistry } from '../../';
import { strimzi } from '../../resources';

const provider = new k8s.Provider("k8s");

export const namespace = new k8s.core.v1.Namespace("apicurio-registry", {}, { provider }).metadata.name;

const crds = new apicurioRegistry.CRDs({ provider });

new apicurioRegistry.Operator({ namespace }, { provider });

const strimziCrds = new strimzi.CRDs({ provider });

new strimzi.Operator("strimzi-kafka-operator", { namespace }, { provider });

const kafka = new strimzi.Kafka("kafka", {
    namespace,
    authenticationType: "scram-sha-512",
    authorizationType: "simple",
}, { provider, dependsOn: [ strimziCrds ] });

const registry = new apicurioRegistry.Registry("test-registry", {
    namespace,
    kafka
}, { provider, dependsOn: [ crds ] });

export const serviceName = registry.serviceName;