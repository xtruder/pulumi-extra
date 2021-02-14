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
        ];

        shellHook = ''
          export PULUMI_CONFIG_PASSPHRASE=""
        '';
      };
    };
}