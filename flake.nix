{
    description = "pulumi-extra";

    inputs = {
      nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    };

    outputs = { self, nixpkgs }: let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      devShell.${system} = pkgs.mkShell {
        buildInputs = with pkgs; [
          pulumi-bin
          kubectl
          nodejs
          postgresql
          jq
          jre
          (apacheKafka.overrideDerivation (p: rec {
            version = "2.13-2.7.0";
            src = pkgs.fetchurl {
              url = "mirror://apache/kafka/2.7.0/kafka_${version}.tgz";
              sha256 = "sha256-HdhLdjZ2oC/stI+l1+fpSivyvp/4e84UzxQQnOHLf5A=";
            };
          }))
        ];

        shellHook = ''
          export PULUMI_CONFIG_PASSPHRASE=""
        '';
      };
    };
}