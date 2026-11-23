# STL Print Check

A static, browser-only STL checker designed for GitHub Pages. It accepts batches of STL files (including 30 or more), reads ASCII and binary STL, reports per-file results, and can export the report as CSV. Files are read locally and are not sent to a server.

## Publish with GitHub Pages

1. Push these files to a GitHub repository.
2. In the repository, open **Settings → Pages**.
3. Choose **Deploy from a branch**, select the branch and `/ (root)`, then save.

The site has no build step or server dependency.

## Checks and limits

- File recognition and triangle data parsing for ASCII and binary STL.
- Maximum X width 30 mm, Y depth 30 mm, Z height 60 mm.
- Geometry guidance for models that sit above or extend below the z=0 workplane, disconnected components, a flat base, small base area, a notably offset footprint, and approximate rotational/reflection symmetry.
- A rough footprint-centre offset warning to prompt a stability review.

STL files do not encode units, intended orientation, printer settings, material, or slicer repairs. This tool assumes coordinates are millimetres and checks the model's original Z position against z=0 with a 0.05 mm tolerance. It provides geometry guidance rather than guaranteeing successful printing. Review each model and sliced preview in Cura.

The symmetry check samples the STL surface and looks for common rotational orders (2 through 12 fold) around Z and reflection across one of several vertical planes. It is approximate; an asymmetry flag is informational and does not fail the file.
