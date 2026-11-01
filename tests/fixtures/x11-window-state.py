"""Reads one X11 window's input-focus and map state for the linux-native E2E cases.

Usage: x11-window-state.py DISPLAY WINDOW_ID  -> one JSON object on stdout
       x11-window-state.py --probe DISPLAY    -> {"ok": true} when libX11 opens DISPLAY

Read-only: it queries the X server (XGetInputFocus, XGetWindowAttributes,
XQueryTree) through the system libX11 with the standard library's ctypes and
changes nothing. "focus_in_window" is true when the X input focus is the
window or one of its descendants.
"""
import ctypes
import ctypes.util
import json
import sys

POINTER_ROOT = 1
MAP_STATES = {0: 'IsUnmapped', 1: 'IsUnviewable', 2: 'IsViewable'}


class XWindowAttributes(ctypes.Structure):
    _fields_ = [
        ('x', ctypes.c_int), ('y', ctypes.c_int), ('width', ctypes.c_int), ('height', ctypes.c_int),
        ('border_width', ctypes.c_int), ('depth', ctypes.c_int), ('visual', ctypes.c_void_p),
        ('root', ctypes.c_ulong), ('class_', ctypes.c_int), ('bit_gravity', ctypes.c_int),
        ('win_gravity', ctypes.c_int), ('backing_store', ctypes.c_int), ('backing_planes', ctypes.c_ulong),
        ('backing_pixel', ctypes.c_ulong), ('save_under', ctypes.c_int), ('colormap', ctypes.c_ulong),
        ('map_installed', ctypes.c_int), ('map_state', ctypes.c_int), ('all_event_masks', ctypes.c_long),
        ('your_event_mask', ctypes.c_long), ('do_not_propagate_mask', ctypes.c_long),
        ('override_redirect', ctypes.c_int), ('screen', ctypes.c_void_p),
    ]


def open_display(name):
    path = ctypes.util.find_library('X11') or 'libX11.so.6'
    x11 = ctypes.CDLL(path)
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    display = x11.XOpenDisplay(name.encode())
    if not display:
        raise SystemExit(f'cannot open X display {name}')
    return x11, display


def parent_of(x11, display, window):
    root, parent = ctypes.c_ulong(), ctypes.c_ulong()
    children, count = ctypes.POINTER(ctypes.c_ulong)(), ctypes.c_uint()
    x11.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
                               ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)), ctypes.POINTER(ctypes.c_uint)]
    if not x11.XQueryTree(display, window, ctypes.byref(root), ctypes.byref(parent), ctypes.byref(children), ctypes.byref(count)):
        return None
    if children:
        x11.XFree(children)
    return parent.value if parent.value != root.value else None


def main(argv):
    if len(argv) == 2 and argv[0] == '--probe':
        open_display(argv[1])
        return {'ok': True}
    if len(argv) != 2:
        raise SystemExit(__doc__)
    x11, display = open_display(argv[0])
    window = int(argv[1])
    focus, revert = ctypes.c_ulong(), ctypes.c_int()
    x11.XGetInputFocus.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int)]
    x11.XGetInputFocus(display, ctypes.byref(focus), ctypes.byref(revert))
    attributes = XWindowAttributes()
    x11.XGetWindowAttributes.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(XWindowAttributes)]
    if not x11.XGetWindowAttributes(display, window, ctypes.byref(attributes)):
        raise SystemExit(f'window {window} does not exist on {argv[0]}')
    inside, current = False, focus.value
    while current not in (0, POINTER_ROOT) and current is not None:
        if current == window:
            inside = True
            break
        current = parent_of(x11, display, current)
    focus_name = {0: 'None', POINTER_ROOT: 'PointerRoot'}.get(focus.value, hex(focus.value))
    return {'focus': focus_name, 'focus_in_window': inside, 'map_state': MAP_STATES.get(attributes.map_state, str(attributes.map_state))}


if __name__ == '__main__':
    print(json.dumps(main(sys.argv[1:])))
