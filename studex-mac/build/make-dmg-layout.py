"""Writes the .DS_Store that lays out the Studex disk image window.

Finder normally writes this file; when Finder cannot be driven (no automation
permission, ssh, CI) build-app.sh falls back to the copy this produces.
Must run with the image mounted, because the background is referenced by an
alias to the file on the volume, and needs two packages the system Python does
not have:

    pip3 install --target /tmp/dmglibs ds_store mac_alias
    PYTHONPATH=/tmp/dmglibs python3 build/make-dmg-layout.py /Volumes/Studex \
        build/dmg-layout.DS_Store

The result is checked in beside this script, so an ordinary build needs none
of it — only a change to the window's size, its icon positions or the
background's dimensions means running this again.
"""
import sys
from ds_store import DSStore
from mac_alias import Alias

mount = sys.argv[1]
out = sys.argv[2]
background = f"{mount}/.background/background.tiff"

alias = Alias.for_file(background).to_bytes()

with DSStore.open(f"{mount}/.DS_Store", "w+") as d:
    d["."]["vSrn"] = ("long", 1)
    d["."]["icvl"] = ("type", "icnv")
    d["."]["bwsp"] = {
        "WindowBounds": "{{200, 140}, {640, 400}}",
        "PreviewPaneVisibility": False,
        "ShowStatusBar": False,
        "ShowTabView": False,
        "ShowToolbar": False,
        "ShowPathbar": False,
        "ShowSidebar": False,
        "SidebarWidth": 180,
        "ViewStyle": "icnv",
    }
    d["."]["icvp"] = {
        "viewOptionsVersion": 1,
        "backgroundType": 2,
        "backgroundImageAlias": alias,
        "backgroundColorRed": 1.0,
        "backgroundColorGreen": 1.0,
        "backgroundColorBlue": 1.0,
        "gridOffsetX": 0.0,
        "gridOffsetY": 0.0,
        "gridSpacing": 100.0,
        "arrangeBy": "none",
        "showIconPreview": False,
        "showItemInfo": False,
        "labelOnBottom": True,
        "textSize": 12.0,
        "iconSize": 112.0,
        "scrollPositionX": 0.0,
        "scrollPositionY": 0.0,
    }
    d["Studex.app"]["Iloc"] = (168, 218)
    d["Applications"]["Iloc"] = (472, 218)

import shutil
shutil.copyfile(f"{mount}/.DS_Store", out)
print("wrote", out)
