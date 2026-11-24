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
- Geometry guidance for models that sit above or extend below the z=0 workplane, a circular vertical opening near the top with depth from 6 mm to 10.3 mm, clearly separate mesh sections, a flat base, small base area, a notably offset footprint, and approximate rotational/reflection symmetry.
- A rough footprint-centre offset warning to prompt a stability review.

STL files do not encode units, intended orientation, printer settings, material, or slicer repairs. This tool assumes coordinates are millimetres and checks the model's original Z position against z=0 with a 0.05 mm tolerance. It provides geometry guidance rather than guaranteeing successful printing. Review each model and sliced preview in Cura.

The symmetry check samples the STL surface and looks for common rotational orders (2 through 12 fold) around Z and reflection across one of several vertical planes. It is approximate; an asymmetry flag is informational and does not fail the file.

The separate-section check only flags mesh components with non-overlapping bounding boxes. Intersecting or overlapping STL shells can represent a single solid, so ambiguous cases are not labelled as separate pieces.

The top-opening check slices the triangle mesh at several heights near the top and tracks the opening contour. It compares changes in contour centre with ellipse direction and proportions to distinguish a likely tilted circular cylinder (which looks oval in horizontal slices) from a clearly oval opening that stays vertical. It uses the typical contour across several slices to reduce false alarms from small variations in the STL's facets. A socket widening toward its deep end is allowed for the click-fit shape. It is an approximate geometry check; it does not require the opening to pass all the way through the model.

Opening depth is estimated by checking where the inner contour closes. The checker compares nearby horizontal slices and waits for the contour to stay absent before treating it as the socket bottom, then refines the estimate with a binary search. This helps avoid false shallow readings when a slice misses part of the STL mesh. The required range is 6 mm to 10.3 mm; the estimate is approximate.
