
import * as pulumi from "@pulumi/pulumi";
import * as tls from "@pulumi/tls";

type KeyAlgorithm = "RSA" | "ECDSA";
type EcdsaCurve = "P224" | "P256" | "P384" | "P521" | "P224";
type RSABits = 1024 | 2048 | 4096;

export const
    defaultKeyAlgorithm: KeyAlgorithm = "ECDSA",
    defaultEcdsaCurve: EcdsaCurve = "P256",
    defaultRSABits: RSABits = 4096,
    defaultValidityPeriodHours = 87600,
    defaultCAAllowedUses = [
        "key_encipherment",
        "digital_signature",
        "cert_signing",
    ],
    defaultCertAllowedUses = [
        "key_encipherment",
        "digital_signature"
    ];

interface CommonCertArgs {
    /**
     * The algorithm to use for the private key.  Defaults to 'ECDSA'.
     */
    readonly keyAlgorithm?: pulumi.Input<KeyAlgorithm>;

    /**
     * Curve to use for ECDA algorihm. Defaults to P244.
     */
    readonly ecdsaCurve?: pulumi.Input<EcdsaCurve>;

    /**
     * The number of RSA bits to use for the private key (for algorithm 'RSA').  Defaults to 2048.
     */
    readonly rsaBits?: pulumi.Input<RSABits>;

    /**
     * The validity period (in hours) of the certificate.  Defaults to 10 years.
     */
    readonly validityPeriodHours?: pulumi.Input<number>;

    readonly allowedUses?: pulumi.Input<pulumi.Input<string>[]>;

    readonly commonName?: pulumi.Input<string>;
    readonly organization?: pulumi.Input<string>;
}

export interface RootSigningCertificateArgs extends CommonCertArgs {}

export interface CertificateArgs extends CommonCertArgs {
    readonly caCert: tls.SelfSignedCert;
    readonly caPrivateKey: tls.PrivateKey;

    readonly dnsNames?: pulumi.Input<pulumi.Input<string>[]>;
}


/**
 * A resource representing a root signing certificate for CA purposes.
 */
export class RootSigningCertificate extends pulumi.ComponentResource {
    public readonly privateKey: tls.PrivateKey;
    public readonly certificate: tls.SelfSignedCert;

    private name: string;

    constructor(name: string, args: RootSigningCertificateArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:tls:RootSigningCertificate", name, {}, opts);

        this.name = name;

        const {
            commonName = name,
            organization,
            rsaBits = defaultRSABits,
            ecdsaCurve = defaultEcdsaCurve,
            keyAlgorithm = defaultKeyAlgorithm,
            validityPeriodHours = defaultValidityPeriodHours,
            allowedUses = defaultCAAllowedUses
        } = args;

        const defaultResourceOptions: pulumi.ResourceOptions = { parent:this };

        this.privateKey = new tls.PrivateKey(`${name}-key`, {
            algorithm: keyAlgorithm,
            rsaBits: rsaBits,
            ecdsaCurve: ecdsaCurve
        }, defaultResourceOptions);

        this.certificate = new tls.SelfSignedCert(`${name}-cert`, {
            subjects: [{
                commonName,
                organization
            }],
            keyAlgorithm: this.privateKey.algorithm,
            privateKeyPem: this.privateKey.privateKeyPem,
            isCaCertificate: true,
            validityPeriodHours: validityPeriodHours,
            allowedUses,
        }, defaultResourceOptions);
    }

    /**
     * Gets the public key associated with the certificate as a PEM-encoded string.
     */
    getPublicKey(): pulumi.Output<string> {
        return this.privateKey.publicKeyPem;
    }

    /**
     * Gets the private key associated with the certificate as a PEM-encoded string.
     */
    getPrivateKey(): pulumi.Output<string> {
        return pulumi.secret<string>(this.privateKey.privateKeyPem);
    }

    /**
     * Gets the certificate as a PEM-encoded string.
     */
    getCertificate(): pulumi.Output<string> {
        return this.certificate.certPem;
    }

    newCert(name: string, args: Omit<CertificateArgs, 'caCert' | 'caPrivateKey'>) {
        return new Certificate(name, {
            ...args,
            caCert: this.certificate,
            caPrivateKey: this.privateKey,
        });
    }
}

export class Certificate extends pulumi.ComponentResource {
    public readonly privateKey: tls.PrivateKey;
    public readonly csr: tls.CertRequest;
    public readonly certificate: tls.LocallySignedCert;

    constructor(name: string, args: CertificateArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-extra:tls:Certificate", name, {}, opts);

        const {
            caCert,
            caPrivateKey,

            keyAlgorithm = args.caCert.keyAlgorithm,
            rsaBits = caPrivateKey.rsaBits as pulumi.Input<number>,
            ecdsaCurve = caPrivateKey.ecdsaCurve as pulumi.Input<string>,

            commonName = name,
            organization = args.caCert.subjects[0].organization as pulumi.Input<string>,
            dnsNames = [args.commonName || name],
            validityPeriodHours = args.caCert.validityPeriodHours,
            allowedUses = defaultCertAllowedUses
        } = args;

        const defaultResourceOptions: pulumi.ResourceOptions = { parent:this };

        this.privateKey = new tls.PrivateKey(`${name}-key`, {
            algorithm: keyAlgorithm,
            rsaBits,
            ecdsaCurve
        }, defaultResourceOptions);

        this.csr = new tls.CertRequest(`${name}-csr`, {
            keyAlgorithm: keyAlgorithm,
            privateKeyPem: this.privateKey.privateKeyPem,
            dnsNames,

            subjects: [{
                commonName,
                organization
            }]
        }, defaultResourceOptions);

        this.certificate = new tls.LocallySignedCert(`${name}-cert`, {
            certRequestPem: this.csr.certRequestPem,

            caKeyAlgorithm: keyAlgorithm,
            caPrivateKeyPem: caPrivateKey.privateKeyPem,
            caCertPem: caCert.certPem,

            validityPeriodHours,
            allowedUses
        }, defaultResourceOptions);
    }

    /**
     * Gets the private key associated with the certificate as a PEM-encoded string.
     */
    getPrivateKey(): pulumi.Output<string> {
        return pulumi.secret<string>(this.privateKey.privateKeyPem);
    }

    /**
     * Gets the certificate as a PEM-encoded string.
     */
    getCertificate(): pulumi.Output<string> {
        return this.certificate.certPem;
    }
}