import * as path from 'path';

import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';

import { filesDir } from './util';
import { includeK8SResourceParams, removeK8SResourceParams, waitK8SCustomResourceCondition, CustomResourceWithBody } from '../../';
import { WithRequired } from '../util';

interface OperatorArgs {
    namespace?: pulumi.Input<string>;
    operatorsNamespace?: pulumi.Input<string>;
    imageRef?: pulumi.Input<string>;
}

export class Operator extends pulumi.ComponentResource {
    public readonly chart: k8s.helm.v3.Chart;

    constructor(name: string, args: OperatorArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:OperatorLifecycleManager", name, {}, opts);

        let {
            namespace = "olm",
            operatorsNamespace: operatorNamespace = "operators",
            imageRef = "quay.io/operator-framework/olm@sha256:de396b540b82219812061d0d753440d5655250c621c753ed1dc67d6154741607",
        } = args;

        let values = {
            namespace: namespace,
            catalog_namespace: namespace,
            operator_namespace: operatorNamespace,
            olm: { image: { ref: imageRef} },
            package: { image: { ref: imageRef } },
        };

        let chartPath = path.join(filesDir, "olm/chart");

        // deploy chart
        this.chart = new k8s.helm.v3.Chart(name, {
            path: chartPath, values,
            transformations: [
                removeK8SResourceParams({kind: "ClusterServiceVersion", name: "packageserver"})
            ]
        }, { parent: this });

        // include only packageserver, this needs to installed separately,
        // as there is an issue with apsiservices not being delete
        // see: https://github.com/operator-framework/operator-lifecycle-manager/issues/1304
        new k8s.helm.v3.Chart(`${name}-packageserver`, {
            path: chartPath, values,
            transformations: [
                includeK8SResourceParams({kind: "ClusterServiceVersion", name: "packageserver"})
            ]
        }, { parent: this.chart });
    }
}

interface OperatorGroupArgs {
    namespace: pulumi.Input<string>;
    targetNamespaces?: pulumi.Input<pulumi.Input<string>[]>;
}

export class OperatorGroup extends pulumi.ComponentResource {
    public readonly operatorGroup: k8s.apiextensions.CustomResource;

    constructor(resourceName: string, args: OperatorGroupArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:OperatorGroup", resourceName, {}, opts);

        let {
            namespace,
            targetNamespaces = [args.namespace]
        } = args;

        this.operatorGroup = new k8s.apiextensions.CustomResource("operatorgroup", {
            apiVersion: "operators.coreos.com/v1",
            kind: "OperatorGroup",
            metadata: {
                name: "operatorgroup",
                namespace
            },
            spec: {
                targetNamespaces
            }
        }, { parent: this, deleteBeforeReplace: true });
    }
}

interface SubscriptionArgs {
    namespace: pulumi.Input<string>;
    
    channel: pulumi.Input<string>;
    name?: pulumi.Input<string>;
    source: pulumi.Input<string>;
    sourceNamespace?: pulumi.Input<string>;
    installPlanApproval?: pulumi.Input<"Manual" | "Automatic">;
    startingCSV?: pulumi.Input<string>;
}

export class Subscription extends pulumi.ComponentResource {
    public readonly subscription: k8s.apiextensions.CustomResource;

    constructor(name: string, args: SubscriptionArgs, opts: WithRequired<pulumi.ComponentResourceOptions, 'provider'>) {
        super("pulumi-extra:k8s:OperatorSubscription", name, {}, opts);

        let {
            namespace,
            channel,
            name: operatorName = name,
            source,
            sourceNamespace = "olm",
            installPlanApproval = "Automatic",
            startingCSV
        } = args;

        this.subscription = new k8s.apiextensions.CustomResource(`${name}-subscription`, {
            apiVersion: "operators.coreos.com/v1alpha1",
            kind: "Subscription",
            metadata: {
                name: operatorName,
                namespace: namespace
            },
            spec: {
                channel,
                name: operatorName,
                source,
                sourceNamespace,
                installPlanApproval,
                ...(startingCSV && {startingCSV})
            }
        }, { parent: this, deleteBeforeReplace: true });
    };
}