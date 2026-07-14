{pkgs}: {
  deps = [
    pkgs.xorg.libxcb
    pkgs.alsa-lib
    pkgs.gtk3
    pkgs.at-spi2-atk
    pkgs.glib
    pkgs.cairo
    pkgs.pango
    pkgs.xorg.libXrandr
    pkgs.xorg.libXfixes
    pkgs.xorg.libXext
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.xorg.libX11
    pkgs.cups
    pkgs.atk
    pkgs.nss
    pkgs.chromium
  ];
}
