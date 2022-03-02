import * as k8s from '@pulumi/kubernetes';
import { keycloakOperator } from '../../';

const provider = new k8s.Provider("k8s");

export const namespace = new k8s.core.v1.Namespace("keycloak", {}, { provider }).metadata.name;

const operator = new keycloakOperator.Operator("keycloak-operator", { namespace }, { provider });
