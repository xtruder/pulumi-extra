import { RootSigningCertificate, defaultValidityPeriodHours } from '../..';
import { check } from '../utils';

/*** minimal CA and cert */

const minimalCa = new RootSigningCertificate("minimal-ca", {});

minimalCa.privateKey.algorithm.apply(check("ECDSA", minimalCa.privateKey));
minimalCa.privateKey.ecdsaCurve.apply(check("P256", minimalCa.privateKey));
minimalCa.certificate.subjects.apply(check(subjects => subjects?.[0].commonName == "minimal-ca", minimalCa.certificate));
minimalCa.certificate.validityPeriodHours.apply(check(defaultValidityPeriodHours, minimalCa.certificate));

const minimalCert = minimalCa.newCert("minimal-cert", {});

minimalCert.privateKey.algorithm.apply(check("ECDSA", minimalCert.privateKey));
minimalCert.privateKey.ecdsaCurve.apply(check("P256", minimalCert.privateKey));
minimalCert.csr.subjects.apply(check(subjects => subjects?.[0].commonName == "minimal-cert", minimalCert.csr));
minimalCert.csr.dnsNames.apply(check(["minimal-cert"], minimalCert.csr));
minimalCert.certificate.validityPeriodHours.apply(check(defaultValidityPeriodHours, minimalCert.certificate));

/*** custom CA and cert */

const customCa = new RootSigningCertificate("custom-ca", {
    commonName: "my root cert",
    organization: "my org",
    keyAlgorithm: "RSA",
    rsaBits: 2048,
    validityPeriodHours: 24,
    allowedUses: [
        "key_encipherment",
        "digital_signature",
        "cert_signing",
    ],
});

customCa.privateKey.algorithm.apply(check("RSA", customCa.privateKey));
customCa.privateKey.rsaBits.apply(check(2048, customCa.privateKey));
customCa.certificate.subjects.apply(check(subjects => subjects?.[0].commonName == "my root cert", customCa.certificate));
customCa.certificate.subjects.apply(check(subjects => subjects?.[0].organization == "my org", customCa.certificate));
customCa.certificate.validityPeriodHours.apply(check(24, customCa.certificate));

const customCert = customCa.newCert("user", {
    commonName: "my-cert",
    dnsNames: ["my-dns-name"],
    rsaBits: 1024,
    validityPeriodHours: 8,
    allowedUses: [
        "digital_signature"
    ] 
});

customCert.privateKey.algorithm.apply(check("RSA", customCert.privateKey));
customCert.privateKey.rsaBits.apply(check(1024, customCert.privateKey));
customCert.csr.subjects.apply(check(subjects => subjects?.[0].commonName == "my-cert", customCert.csr));
customCert.csr.dnsNames.apply(check(["my-dns-name"], customCert.csr));
customCert.certificate.allowedUses.apply(check(["digital_signature"], customCert.certificate));
customCert.certificate.validityPeriodHours.apply(check(8, customCert.certificate));
