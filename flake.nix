{
    description = "pulumi-extra";

    inputs = {
      nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    };

    outputs = { self, nixpkgs }: let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};

      crd2pulumi = pkgs.buildGoModule rec {
        pname = "crd2pulumi";
        version = "v1.0.5";
        src = pkgs.fetchurl {
          url = "https://github.com/pulumi/crd2pulumi/archive/refs/tags/${version}.tar.gz";
          sha256 = "sha256-RkRCO8brf82UDPPyF+ms105SYBpkBLMGB/zOeuBOcFg=";
        };
        vendorSha256 = "sha256-eoWKtF/jzY8/2x94KKEsRoMQC6H+04n6Rj4wVkigNpg=";
      };

      k8split = pkgs.buildGoModule rec {
        pname = "k8split";
        version = "7469c282";
        src = pkgs.fetchurl {
          url = "https://github.com/brendanjryan/k8split/archive/7469c282.tar.gz";
          sha256 = "sha256-dsuQcpy686btgfnOi6tPdoyRVljtzhrA1rHfAmA2HTY=";
        };
        vendorSha256 = "sha256-L0CdTy6dIpamnnNech078NWApafoVjjjyM83Cv5lbUo=";
      };
    in {
      devShell.${system} = pkgs.mkShell {
        buildInputs = with pkgs; [
          pulumi-bin
          kubectl
          nodejs
          postgresql_12
          jq
          docker
          libvirt
          minikube
          docker-machine-kvm2
          kubernetes-helm
          (confluent-platform.overrideDerivation (p: {
            version = "6.1.0";
            src = pkgs.fetchurl {
              url = "https://packages.confluent.io/archive/6.1/confluent-community-6.1.0.tar.gz";
              sha256 = "sha256-U7Di8IxM/FUIf6XJEgphTvBNMG227DvNdxD4nwU1U1U=";
            };
          }))
          netcat
          crd2pulumi
          k8split
        ];

        shellHook = ''
          export PULUMI_CONFIG_PASSPHRASE=""

          if minikube docker-env > /dev/null; then
            eval "$(minikube docker-env)"
          fi
        '';
      };
    };
}