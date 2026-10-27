# Surface Tracking and Ground Grid Preview

8th Wall World Tracking maintains a horizontal ground plane at `Y = 0` and may redefine that plane from visible feature points. XR8 does not provide separate floor and table planes with independent IDs and heights. [World Tracking Issues](https://8thwall.org/docs/troubleshooting/world-tracking-issues).

In the app, the center-screen raycast uses the XR8 ground reference at `Y = 0` for the model placement reticle. The Ground Grid Preview is always hidden. The reticle appears only after World Tracking has remained `NORMAL` for about 350 ms; it temporarily disappears when tracking is `LIMITED`, the camera points horizontally or upward, or the pose jumps sharply. The X/Z position is smoothed, and height does not depend on camera distance. The floor/table selector and calibration controls and the 6DoF HUD are no longer present.

After placement, the model remains attached to the world anchor. Ground Grid Preview does not change the model transform or call `XR8.recenter()`. If XR8 redefines the world origin, the scene matrices may remain unchanged while the perceived real-world position shifts. Check on a phone to confirm physical alignment.

The placed model has a target height of 30 cm, 1.5 times the previous 20 cm target. Its size before placement in camera-lock mode is unchanged.

After placement, pinch on the camera view to scale the model from 0.5 to 2 times its initial placed size. This gesture changes only the model scale; its position and rotation in the world anchor remain unchanged. The selected size is retained when using “Reposition” to place the model again. A one-finger drag still rotates the bottle; a two-finger gesture does not trigger placement or open ingredient details.

Code checks: `npm run test:surface` and `npm run build`.
