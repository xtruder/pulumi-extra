import * as k8s from '@pulumi/kubernetes';

import { OperatorLifecycleManager, StrimziKafkaOperator, Kafka } from '../..';

const provider = new k8s.Provider("k8s");

const olm = new OperatorLifecycleManager("olm", {}, { provider });

const operator = new StrimziKafkaOperator({}, {provider, dependsOn: [olm]});

export const namespace = new k8s.core.v1.Namespace("strimzi", {}, { provider }).metadata.name;

const kafka = new Kafka("kafka", {
    namespace
}, {provider, dependsOn: [operator]});