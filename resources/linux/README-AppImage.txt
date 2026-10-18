Interleaf for Linux (AppImage)
==============================

{{APPIMAGE}} runs Interleaf on 64-bit Linux (x86_64).
It needs no installer and no root access.

1. Save it in a folder you can write to, for example ~/Applications.

2. Make it executable.
   File manager: open the file's Properties > Permissions and
   allow executing the file as a program.
   Terminal:
     mkdir -p ~/Applications
     mv ~/Downloads/{{APPIMAGE}} ~/Applications/
     chmod +x ~/Applications/{{APPIMAGE}}

3. Run it: double-click the file, or in a terminal:
     ~/Applications/{{APPIMAGE}}

Updates
   Settings > About & Updates checks for, downloads and installs
   new versions. This works when you run the AppImage file itself
   from a writable folder, as above.

Error about libfuse.so.2
   AppImages need the FUSE 2 library:
     Ubuntu 24.04:  sudo apt install libfuse2t64
     Ubuntu 22.04:  sudo apt install libfuse2
   Other distributions: install your FUSE 2 library package, see
   https://docs.appimage.org/user-guide/troubleshooting/fuse.html
   Do not install a package named "fuse" that would remove fuse3.

Error about the sandbox
   Install the .deb or pacman package from the same release instead.
