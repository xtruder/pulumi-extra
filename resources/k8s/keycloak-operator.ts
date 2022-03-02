import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import { removeK8SResourceParams } from '../../utils';

const
    version = "12.0.4",
    kustomization = `https://github.com/keycloak/keycloak-operator/tree/${version}/deploy`;

/**
 * OperatorArgs defines Operator arguments
 */
interface OperatorArgs {
    /**
     * Namespace where to install grafana operator
     */
    namespace: pulumi.Input<string>;
}

export class Operator extends pulumi.ComponentResource {
    /**
     * Name of namespace where operator was installed
     */
    public readonly namespace: pulumi.Output<string>;

    /**
     * Kustomiztion used to deploy keycloak operator
     */
    public readonly kustomization: k8s.kustomize.Directory;

    constructor(name: string, args: OperatorArgs, opts: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:k8s:KeycloakOperator", name, {}, opts);

        let {
            namespace
        } = args;

        const keycloak = new k8s.kustomize.Directory("keycloak-operator", {
            directory: kustomization,
            transformations: [
                // we will create namespace ourselves
                removeK8SResourceParams({kind: "Namespace"}),

                // fix namespace to deploy in our namespace
                ((resource) => {
                    resource.metadata.namespace = namespace;
                }),

                // fix RoleBinding namespace
                ((resource) => {
                    if (resource.kind == "RoleBinding") {
                        for (const subject of resource.subjects || []) {
                            subject.namespace = namespace;
                        }
                    }
                })
            ]
        }, { parent: this });

        this.kustomization = keycloak;
    }
}