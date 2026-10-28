package dev.droidreplay.agent;

import android.app.UiAutomation;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction;
import android.view.accessibility.AccessibilityWindowInfo;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import org.json.JSONArray;
import org.json.JSONObject;

/** All device operations. Every op takes a JSON step and returns a short message or throws. */
final class Device {
    private static final int MAX_LABEL = 100;
    private static final long POLL_MS = 40;

    private final UiAutomation automation;
    private final Method injectNoAnimWait;
    // Tap targets from the latest observe, so steps can say {"ref": 12}.
    private final Map<Integer, Ref> refs = new HashMap<>();
    // Stable selector of the element the current step acted on, reported so flows can be recorded.
    private JSONObject lastSel;

    /** What observe saw for one @ref: where to tap and how to find it again later. */
    private static final class Ref {
        final int x, y;
        final Rect bounds;     // visible part, for crops
        final String id;       // short resource id (after ":id/"), or null
        final String text;     // first label part, or null
        final boolean ownText; // text comes from the node itself, not a folded-in child

        Ref(Rect bounds, String id, String text, boolean ownText) {
            this.x = bounds.centerX();
            this.y = bounds.centerY();
            this.bounds = bounds;
            this.id = id;
            this.text = text;
            this.ownText = ownText;
        }
    }

    Device(UiAutomation automation) {
        this.automation = automation;
        Method m = null;
        try {
            // Hidden 3-arg variant (API 33+). The public 2-arg one also waits for animations to end (~1 s).
            m = UiAutomation.class.getDeclaredMethod("injectInputEvent", InputEvent.class, boolean.class, boolean.class);
            m.setAccessible(true);
        } catch (NoSuchMethodException ignored) {
        }
        injectNoAnimWait = m;
    }

    // The node cache is what makes reads fast (a cold read of the launcher takes ~500 ms instead
    // of ~50), so it is only dropped where it can be stale and the cost is hidden.
    private long lastClear;
    private static final long CLEAR_EVERY_MS = 1000;
    // Set by walk; the next observe re-reads a screen that had a WebView.
    private boolean sawWebView;

    /**
     * Drops this process's cached accessibility nodes so the next read asks the app again, at
     * most once per `everyMs`. Chromium (WebView) does not always send a content-changed event,
     * e.g. when an ad's "Lanjut ke aplikasi" fades in, and the cache kept serving the tree
     * without it. Waits call this while polling; observe calls it after a screen with a WebView.
     */
    private void clearCacheEvery(long everyMs) {
        long now = SystemClock.uptimeMillis();
        if (now - lastClear < everyMs) return;
        lastClear = now;
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                automation.clearCache();
            } else {
                Class<?> c = Class.forName("android.view.accessibility.AccessibilityInteractionClient");
                Object client = c.getMethod("getInstance").invoke(null);
                c.getMethod("clearCache").invoke(client);
            }
        } catch (Throwable ignored) {
            // Best effort: without it reads may be stale, but they still work.
        }
    }

    /** The step's element is not there (or hidden); an optional step is skipped instead of failing. */
    static final class Missing extends IllegalStateException {
        Missing(String message) {
            super(message);
        }
    }

    // What dismissAny tapped away during the current step, reported in its output.
    private final List<String> dismissed = new ArrayList<>();

    /**
     * Taps the first of the step's "dismiss" selectors that is on screen (an interstitial's
     * close, a permission prompt) and reports whether it did. Called while a step waits for its
     * element, so things that pop up at unpredictable times get out of the way.
     */
    private boolean dismissAny(JSONObject s) throws Exception {
        JSONArray list = s.optJSONArray("dismiss");
        if (list == null) return false;
        for (int i = 0; i < list.length(); i++) {
            JSONObject sel = list.optJSONObject(i);
            if (sel == null || find(sel) == null) continue;
            JSONObject keep = lastSel;
            try {
                tap(sel, false);
            } catch (Missing e) {
                continue; // found but covered
            } finally {
                lastSel = keep;
            }
            dismissed.add(describe(sel));
            SystemClock.sleep(DISMISS_SETTLE_MS);
            return true;
        }
        return false;
    }

    private static final long DISMISS_SETTLE_MS = 300;

    /** Runs steps in order; `onResult` (may be null) gets each step's result as soon as it is known. */
    JSONObject run(JSONArray steps, boolean stopOnError, java.util.function.Consumer<JSONObject> onResult) throws Exception {
        long t0 = SystemClock.uptimeMillis();
        JSONArray results = new JSONArray();
        boolean allOk = true;
        for (int i = 0; i < steps.length(); i++) {
            JSONObject step = steps.getJSONObject(i);
            String op = step.optString("op");
            long s0 = SystemClock.uptimeMillis();
            JSONObject r = new JSONObject().put("op", op);
            lastSel = null;
            dismissed.clear();
            try {
                String out = exec(op, step);
                if (!dismissed.isEmpty()) out += " (dismissed " + String.join(", ", dismissed) + ")";
                r.put("ok", true).put("out", out);
                if (lastSel != null) r.put("sel", lastSel);
            } catch (Missing e) {
                // Optional steps cover things that show up only sometimes (ads, prompts).
                if (step.optBoolean("optional")) {
                    r.put("ok", true).put("out", "skipped (" + e.getMessage() + ")");
                } else {
                    allOk = false;
                    r.put("ok", false).put("error", e.getMessage());
                }
            } catch (Exception e) {
                allOk = false;
                r.put("ok", false).put("error", e.getMessage() != null ? e.getMessage() : e.toString());
            }
            r.put("ms", SystemClock.uptimeMillis() - s0);
            results.put(r);
            if (onResult != null) onResult.accept(r);
            if (!r.getBoolean("ok") && stopOnError) break;
        }
        return new JSONObject().put("ok", allOk).put("results", results).put("ms", SystemClock.uptimeMillis() - t0);
    }

    private String exec(String op, JSONObject s) throws Exception {
        switch (op) {
            case "observe": return observe();
            case "windows": return describeWindows();
            case "tap": return tap(s, false);
            case "long_press": return tap(s, true);
            case "type": return type(s);
            case "swipe": return swipe(s.getInt("x1"), s.getInt("y1"), s.getInt("x2"), s.getInt("y2"), s.optInt("ms", 250));
            case "scroll": return scroll(s);
            case "key": return key(s.getString("key"));
            case "wait_for": return waitFor(s, false);
            case "wait_gone": return waitFor(s, true);
            case "wait_idle": return waitIdle(s.optInt("quietMs", 300), s.optInt("timeout", 5000));
            case "sleep": SystemClock.sleep(s.getLong("ms")); return "ok";
            case "hide_keyboard": return hideKeyboard();
            default: throw new IllegalArgumentException("unknown op: " + op);
        }
    }

    // ---------------------------------------------------------------- observe

    /** One app-facing window: its root plus a name for the header line. */
    private static final class Win {
        final AccessibilityNodeInfo root;
        final String name;

        Win(AccessibilityNodeInfo root, String name) {
            this.root = root;
            this.name = name;
        }
    }

    private boolean keyboardShown;

    /**
     * Windows a user can act on, top-most first: app windows (activities, dialogs, popups,
     * permission prompts) plus whichever window is active. Status/navigation bars and the
     * keyboard are left out; the keyboard only sets keyboardShown, since `type` sets text directly.
     */
    private List<Win> windows() {
        List<Win> out = new ArrayList<>();
        keyboardShown = false;
        for (AccessibilityWindowInfo w : automation.getWindows()) {
            int type = w.getType();
            if (type == AccessibilityWindowInfo.TYPE_INPUT_METHOD) {
                keyboardShown = true;
                continue;
            }
            if (type != AccessibilityWindowInfo.TYPE_APPLICATION && !w.isActive()) continue;
            AccessibilityNodeInfo root = w.getRoot();
            if (root == null) continue;
            CharSequence title = w.getTitle();
            out.add(new Win(root, title != null && title.length() > 0 ? title.toString() : String.valueOf(root.getPackageName())));
        }
        if (out.isEmpty()) {
            AccessibilityNodeInfo root = automation.getRootInActiveWindow();
            if (root != null) out.add(new Win(root, String.valueOf(root.getPackageName())));
        }
        return out;
    }

    /** Debug view of every window the system reports, including the ones observe skips. */
    private String describeWindows() {
        StringBuilder sb = new StringBuilder();
        for (AccessibilityWindowInfo w : automation.getWindows()) {
            AccessibilityNodeInfo root = w.getRoot();
            Rect r = new Rect();
            w.getBoundsInScreen(r);
            sb.append("type=").append(w.getType()).append(" layer=").append(w.getLayer())
                    .append(w.isActive() ? " active" : "").append(w.isFocused() ? " focused" : "")
                    .append(" title=").append(w.getTitle())
                    .append(" pkg=").append(root == null ? "(no root)" : root.getPackageName())
                    .append(" bounds=").append(r.toShortString()).append('\n');
        }
        return sb.toString();
    }

    // Set by walk when it skips something hidden under a bar or an overlay (sheet, backdrop).
    private boolean skippedCovered;

    String observe() {
        if (sawWebView) clearCacheEvery(0);
        sawWebView = false;
        List<Win> wins = windows();
        refs.clear();
        skippedCovered = false;
        if (wins.isEmpty()) return "(no window)";
        StringBuilder sb = new StringBuilder();
        sb.append("app=").append(wins.get(0).root.getPackageName());
        // Tells a popup or dialog apart from the activity when it is the only window.
        if (wins.size() == 1) sb.append(" window=\"").append(wins.get(0).name).append('"');
        if (keyboardShown) sb.append(" keyboard=shown");
        sb.append('\n');
        for (Win w : wins) {
            // Headers only when there is more than one window, e.g. a dialog over an activity.
            if (wins.size() > 1) sb.append("-- ").append(w.name).append('\n');
            walk(w.root, sb, false, new ArrayList<>());
        }
        if (skippedCovered) sb.append("(elements hidden under bars or overlays not listed)\n");
        return sb.toString();
    }

    /**
     * One line per node worth knowing about. Text inside a clickable node is folded into that
     * node's label, so an icon + title + container shows up once instead of three times.
     */
    private void walk(AccessibilityNodeInfo n, StringBuilder sb, boolean absorbed, List<Rect> covers) {
        if (n == null || !n.isVisibleToUser()) return;
        // Fully hidden under a later sibling (a sheet's backdrop, a dialog layer): nothing in
        // it can be seen or tapped, so neither it nor its subtree is listed.
        Rect vis = new Rect();
        n.getBoundsInScreen(vis);
        for (Rect c : covers) cut(vis, c);
        if (vis.isEmpty() && !covers.isEmpty()) {
            skippedCovered = true;
            return;
        }
        CharSequence cls = n.getClassName();
        if (cls != null && cls.toString().endsWith("WebView")) sawWebView = true;
        boolean pressable = n.isClickable() || n.isLongClickable() || n.isCheckable();
        boolean emit;
        String label;
        if (pressable) {
            emit = true;
            Set<String> parts = new LinkedHashSet<>();
            addText(n, parts);
            collectText(n, parts);
            label = join(parts);
        } else if (n.isEditable() || n.isScrollable()) {
            emit = true;
            Set<String> parts = new LinkedHashSet<>();
            addText(n, parts);
            label = join(parts);
        } else {
            Set<String> parts = new LinkedHashSet<>();
            addText(n, parts);
            label = join(parts);
            emit = !absorbed && !label.isEmpty();
        }

        if (emit) {
            // Tap targets get the point a tap would actually reach: the center of the visible part.
            Rect r = new Rect();
            if (pressable || n.isEditable()) r = vis;
            else n.getBoundsInScreen(r);
            int ref = refs.size();
            String shortId = n.getViewIdResourceName();
            if (shortId != null) shortId = shortId.substring(shortId.indexOf('/') + 1);
            Set<String> own = new LinkedHashSet<>();
            addText(n, own);
            String firstPart = label.isEmpty() ? null : label.split(" · ")[0];
            refs.put(ref, new Ref(r, shortId, firstPart, !own.isEmpty()));
            sb.append('@').append(ref).append(' ').append(shortClass(n.getClassName()));
            String hint = n.isEditable() && n.getHintText() != null ? n.getHintText().toString() : "";
            // An empty field reports its hint as its text; print it once, as the hint.
            if (!label.isEmpty() && !label.equals(hint)) sb.append(" \"").append(label).append('"');
            String id = n.getViewIdResourceName();
            if (id != null) sb.append(" #").append(id.substring(id.indexOf('/') + 1));
            if (!hint.isEmpty()) sb.append(" hint=\"").append(hint).append('"');
            sb.append(" [").append(r.centerX()).append(',').append(r.centerY()).append(']');
            if (n.isClickable()) sb.append(" tap");
            if (n.isEditable()) sb.append(" edit");
            if (n.isScrollable()) sb.append(" scroll");
            if (n.isCheckable()) sb.append(n.isChecked() ? " on" : " off");
            if (n.isSelected()) sb.append(" selected");
            if (!n.isEnabled()) sb.append(" disabled");
            // No label to go by: tells the model a crop (screenshot refs) shows what it is.
            if (pressable && label.isEmpty() && hasImage(n, new int[] {50})) sb.append(" icon");
            sb.append('\n');
        }
        // Children of a pressable node had their text folded in above; only their own actions show.
        boolean childAbsorbed = absorbed || pressable;
        int count = n.getChildCount();
        boolean[] hidden = coveredScreens(n);
        if (count < 2) {
            for (int i = 0; i < count; i++) walk(n.getChild(i), sb, childAbsorbed, covers);
            return;
        }
        // Same covers as visibleRect, computed once per parent instead of per node.
        Rect pb = new Rect();
        n.getBoundsInScreen(pb);
        AccessibilityNodeInfo[] kids = new AccessibilityNodeInfo[count];
        Rect[] bounds = new Rect[count];
        Rect[] cover = new Rect[count];
        for (int i = 0; i < count; i++) {
            if (hidden != null && hidden[i]) continue;
            kids[i] = n.getChild(i);
            bounds[i] = new Rect();
            if (kids[i] != null && kids[i].isVisibleToUser()) kids[i].getBoundsInScreen(bounds[i]);
        }
        for (int i = 0; i < count; i++) {
            if (kids[i] == null) continue;
            List<Rect> mine = covers;
            for (int j = i + 1; j < count; j++) {
                if (bounds[j] == null || bounds[j].isEmpty() || !Rect.intersects(bounds[i], bounds[j])) continue;
                if (cover[j] == null) cover[j] = coverOf(kids[j], bounds[j], pb);
                if (mine == covers) mine = new ArrayList<>(covers);
                mine.add(cover[j]);
            }
            walk(kids[i], sb, childAbsorbed, mine);
        }
    }

    private static boolean hasImage(AccessibilityNodeInfo n, int[] budget) {
        if (n == null || budget[0]-- <= 0) return false;
        CharSequence cls = n.getClassName();
        if (cls != null && (cls.toString().contains("Image") || cls.toString().contains("Svg"))) return true;
        for (int i = 0; i < n.getChildCount(); i++) if (hasImage(n.getChild(i), budget)) return true;
        return false;
    }

    /** What a later sibling hides: its bounds, or only its content when it fills the parent. */
    private static Rect coverOf(AccessibilityNodeInfo sib, Rect sb, Rect parent) {
        if (!sb.contains(parent)) return sb;
        Rect content = new Rect();
        contentBounds(sib, content, new int[] {COVER_SCAN_LIMIT});
        return content;
    }

    // How much of the parent's height a covering child's content must span to count as a screen.
    private static final float COVER_SPAN = 0.5f;
    private static final int COVER_SCAN_LIMIT = 300;

    // How much of an earlier sibling's content must sit under the cover's content to hide it.
    private static final float COVER_OVERLAP = 0.5f;

    /**
     * Children to skip, or null. JS navigators (React Navigation, Flutter's Navigator) keep
     * earlier screens mounted as full-size siblings below the current one, and accessibility
     * still reports them as visible. A later child that fills the parent and has content spread
     * over at least half of it hides the siblings before it whose content mostly lies under
     * its content. A full-size layer holding only a small button (a FAB host, a toast) does not
     * count, and neither does a sibling beside the cover's content: a full-size ad container
     * whose content starts below a header leaves that header visible.
     */
    private static boolean[] coveredScreens(AccessibilityNodeInfo n) {
        int count = n.getChildCount();
        if (count < 2) return null;
        Rect parent = new Rect();
        n.getBoundsInScreen(parent);
        if (parent.isEmpty()) return null;
        for (int i = count - 1; i > 0; i--) {
            AccessibilityNodeInfo c = n.getChild(i);
            if (c == null || !c.isVisibleToUser()) continue;
            Rect r = new Rect();
            c.getBoundsInScreen(r);
            if (!r.contains(parent)) continue;
            Rect cover = new Rect();
            contentBounds(c, cover, new int[] {COVER_SCAN_LIMIT});
            if (cover.height() < parent.height() * COVER_SPAN) continue;
            boolean[] hidden = new boolean[count];
            for (int k = 0; k < i; k++) {
                Rect content = new Rect();
                contentBounds(n.getChild(k), content, new int[] {COVER_SCAN_LIMIT});
                Rect overlap = new Rect();
                // Empty siblings hide nothing either way; skipping them saves the walk.
                hidden[k] = content.isEmpty() || (overlap.setIntersect(content, cover)
                        && (long) overlap.width() * overlap.height() >= COVER_OVERLAP * content.width() * content.height());
            }
            return hidden;
        }
        return null;
    }

    /** Union of the bounds of nodes a user would see as content: text, descriptions, controls. */
    private static void contentBounds(AccessibilityNodeInfo n, Rect out, int[] budget) {
        if (n == null || budget[0]-- <= 0 || !n.isVisibleToUser()) return;
        CharSequence t = n.getText();
        CharSequence d = n.getContentDescription();
        if ((t != null && t.length() > 0) || (d != null && d.length() > 0) || n.isClickable() || n.isEditable()) {
            Rect r = new Rect();
            n.getBoundsInScreen(r);
            out.union(r);
        }
        for (int i = 0; i < n.getChildCount(); i++) contentBounds(n.getChild(i), out, budget);
    }

    private static void addText(AccessibilityNodeInfo n, Set<String> parts) {
        CharSequence t = n.getText();
        CharSequence d = n.getContentDescription();
        if (t != null && t.toString().trim().length() > 0) parts.add(t.toString().trim());
        if (d != null && d.toString().trim().length() > 0) parts.add(d.toString().trim());
    }

    private static void collectText(AccessibilityNodeInfo n, Set<String> parts) {
        boolean[] hidden = coveredScreens(n);
        for (int i = 0; i < n.getChildCount(); i++) {
            if (hidden != null && hidden[i]) continue;
            AccessibilityNodeInfo c = n.getChild(i);
            if (c == null || !c.isVisibleToUser()) continue;
            if (c.isClickable() || c.isCheckable()) continue; // gets its own line
            addText(c, parts);
            collectText(c, parts);
        }
    }

    private static String join(Set<String> parts) {
        // A content-desc often repeats its children's text ("Kelas 7 - A, Geografi, 10:39"
        // over "Kelas 7 - A" and "Geografi"); keep only parts no other part already contains.
        List<String> kept = new ArrayList<>();
        for (String p : parts) {
            String lp = p.toLowerCase(Locale.ROOT);
            boolean contained = false;
            for (String q : parts) {
                if (q != p && q.length() > p.length() && q.toLowerCase(Locale.ROOT).contains(lp)) {
                    contained = true;
                    break;
                }
            }
            if (!contained) kept.add(p);
        }
        String s = String.join(" · ", kept).replace('\n', ' ').replace("\"", "'");
        return s.length() > MAX_LABEL ? s.substring(0, MAX_LABEL) + "…" : s;
    }

    private static String shortClass(CharSequence cls) {
        if (cls == null) return "View";
        String s = cls.toString();
        return s.substring(s.lastIndexOf('.') + 1);
    }

    // ---------------------------------------------------------------- selectors

    /**
     * Resolves a step's selector (ref | x,y | text | id | desc) to a screen point. With "wait"
     * (ms), a text/id/desc selector is polled until it appears, which replays rely on.
     */
    private int[] point(JSONObject s) throws Exception {
        if (s.has("ref")) {
            Ref ref = refs.get(s.optInt("ref"));
            if (ref == null) throw new IllegalArgumentException("unknown ref @" + s.optInt("ref") + " (observe again)");
            lastSel = selectorFor(ref);
            return new int[]{ref.x, ref.y};
        }
        if (s.has("x") && s.has("y")) return new int[]{s.optInt("x"), s.optInt("y")};
        AccessibilityNodeInfo n = find(s);
        long wait = s.optLong("wait", 0);
        long deadline = SystemClock.uptimeMillis() + wait;
        while (n == null && SystemClock.uptimeMillis() < deadline) {
            // Time spent on a popup does not count against the step's own wait.
            if (dismissAny(s)) deadline = SystemClock.uptimeMillis() + wait;
            else SystemClock.sleep(POLL_MS);
            clearCacheEvery(CLEAR_EVERY_MS);
            n = find(s);
        }
        if (n == null) throw new Missing("not found: " + describe(s));
        lastSel = new JSONObject();
        for (String k : new String[]{"text", "id", "desc"}) if (s.has(k)) lastSel.put(k, s.optString(k));
        for (String k : RELATIVE) if (s.has(k)) lastSel.put(k, s.opt(k));
        if (s.has("index")) lastSel.put("index", s.optInt("index"));
        AccessibilityNodeInfo target = n;
        // Text usually sits on a child of the thing that is actually clickable.
        while (target != null && !target.isClickable() && !target.isEditable()) target = target.getParent();
        if (target == null) target = n;
        Rect r = visibleRect(target);
        if (r.isEmpty()) throw new Missing(describe(s) + " is covered by another element (scroll it into view)");
        return new int[]{r.centerX(), r.centerY()};
    }

    /**
     * The part of a node not hidden by siblings drawn after it or after one of its ancestors,
     * e.g. a list card half under a bottom tab bar. A later sibling that fills its parent (an
     * overlay layer) only covers with its content; a smaller one covers with its whole bounds.
     * Only covers spanning (nearly) the full width or height are cut away, which is what bars,
     * floating tab bars and sheets do; a corner overlap leaves the rect as is.
     */
    private static Rect visibleRect(AccessibilityNodeInfo n) {
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        AccessibilityNodeInfo child = n;
        AccessibilityNodeInfo parent = n.getParent();
        while (parent != null && !r.isEmpty()) {
            Rect pb = new Rect();
            parent.getBoundsInScreen(pb);
            boolean after = false;
            for (int i = 0; i < parent.getChildCount(); i++) {
                AccessibilityNodeInfo sib = parent.getChild(i);
                if (sib == null) continue;
                if (!after) {
                    after = sib.equals(child);
                    continue;
                }
                if (!sib.isVisibleToUser()) continue;
                Rect sb = new Rect();
                sib.getBoundsInScreen(sb);
                if (!Rect.intersects(sb, r)) continue;
                cut(r, coverOf(sib, sb, pb));
            }
            child = parent;
            parent = parent.getParent();
        }
        return r;
    }

    // A cover this much of a node's width (or height) counts as spanning it: floating tab bars
    // are inset a little from the cards they sit on.
    private static final float SPAN = 0.9f;

    /** Removes `o` from `r` when `o` spans most of r's width or height; keeps the bigger side. */
    private static void cut(Rect r, Rect o) {
        if (!Rect.intersects(r, o)) return;
        Rect i = new Rect(r);
        i.intersect(o);
        if (i.width() >= r.width() * SPAN) {
            int above = Math.max(0, o.top - r.top), below = Math.max(0, r.bottom - o.bottom);
            if (above == 0 && below == 0) r.setEmpty();
            else if (above >= below) r.bottom = o.top;
            else r.top = o.bottom;
        } else if (i.height() >= r.height() * SPAN) {
            int left = Math.max(0, o.left - r.left), right = Math.max(0, r.right - o.right);
            if (left == 0 && right == 0) r.setEmpty();
            else if (left >= right) r.right = o.left;
            else r.left = o.right;
        }
    }

    /**
     * The most stable way to find a ref again: a unique id, else a unique label, else id + own
     * text, else the label. Null when the element has neither (the caller keeps coordinates).
     */
    private JSONObject selectorFor(Ref ref) throws Exception {
        int sameId = 0;
        int sameText = 0;
        for (Ref other : refs.values()) {
            if (ref.id != null && ref.id.equals(other.id)) sameId++;
            if (ref.text != null && ref.text.equals(other.text)) sameText++;
        }
        JSONObject sel = new JSONObject();
        if (ref.id != null && sameId == 1) return sel.put("id", ref.id);
        if (ref.text != null && sameText == 1) return sel.put("text", ref.text);
        if (ref.id != null && ref.text != null && ref.ownText) return sel.put("id", ref.id).put("text", ref.text);
        if (ref.text != null) return sel.put("text", ref.text);
        return null;
    }

    /** Position keys: the target must lie on that side of another element (an anchor). */
    static final String[] RELATIVE = {"below", "above", "leftOf", "rightOf"};

    private static boolean hasRelative(JSONObject s) {
        for (String k : RELATIVE) if (s.has(k)) return true;
        return false;
    }

    /** An anchor is a target too: "text" or {text|id|desc}. */
    private static JSONObject anchorSel(Object v) throws Exception {
        if (v instanceof JSONObject) return (JSONObject) v;
        return new JSONObject().put("text", String.valueOf(v));
    }

    private AccessibilityNodeInfo find(JSONObject s) {
        boolean own = s.has("text") || s.has("id") || s.has("desc");
        if (!own && !hasRelative(s)) {
            throw new IllegalArgumentException("selector needs ref, x/y, text, id, desc, or below/above/leftOf/rightOf");
        }
        List<AccessibilityNodeInfo> all = new ArrayList<>();
        for (Win w : windows()) flatten(w.root, all);
        if (hasRelative(s)) return findRelative(s, own, all);
        if (s.has("index")) return nth(s, all);
        AccessibilityNodeInfo partial = null;
        for (AccessibilityNodeInfo n : all) {
            int m = match(n, s);
            if (m == 2) return n;
            if (m == 1 && partial == null) partial = n;
        }
        return partial;
    }

    /**
     * Like Maestro's below/above/leftOf/rightOf: among the matches (or, with no text/id/desc,
     * the tappable elements) on the right side of every anchor, the one closest to them. A node
     * that contains an anchor, or sits inside it, never counts; exact text beats contains.
     */
    private AccessibilityNodeInfo findRelative(JSONObject s, boolean own, List<AccessibilityNodeInfo> all) {
        List<String> keys = new ArrayList<>();
        List<Rect> anchors = new ArrayList<>();
        try {
            for (String k : RELATIVE) {
                if (!s.has(k)) continue;
                AccessibilityNodeInfo a = find(anchorSel(s.opt(k)));
                if (a == null) return null; // anchor not on screen (yet)
                Rect r = new Rect();
                a.getBoundsInScreen(r);
                keys.add(k);
                anchors.add(r);
            }
        } catch (IllegalArgumentException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalArgumentException("bad anchor: " + e.getMessage());
        }
        List<AccessibilityNodeInfo> found = new ArrayList<>();
        List<double[]> rank = new ArrayList<>(); // {match, distance}
        for (AccessibilityNodeInfo n : all) {
            int m = own ? match(n, s) : (n.isClickable() ? 2 : 0);
            if (m == 0) continue;
            Rect b = new Rect();
            n.getBoundsInScreen(b);
            if (b.isEmpty()) continue;
            double dist = 0;
            boolean ok = true;
            for (int i = 0; i < keys.size() && ok; i++) {
                Rect a = anchors.get(i);
                if (b.contains(a) || a.contains(b)) ok = false;
                else ok = side(keys.get(i), a, b);
                dist += Math.hypot(b.centerX() - a.centerX(), b.centerY() - a.centerY());
            }
            if (!ok) continue;
            found.add(n);
            rank.add(new double[]{m, dist});
        }
        // Exact before contains, then nearest first; `index` counts in that order.
        Integer[] order = new Integer[found.size()];
        for (int i = 0; i < order.length; i++) order[i] = i;
        java.util.Arrays.sort(order, (x, y) -> {
            double[] a = rank.get(x), b = rank.get(y);
            return a[0] != b[0] ? Double.compare(b[0], a[0]) : Double.compare(a[1], b[1]);
        });
        int idx = s.optInt("index", 0);
        return idx >= 0 && idx < order.length ? found.get(order[idx]) : null;
    }

    /**
     * `index` without a position: the n-th match (0-based) in reading order, top to bottom then
     * left to right; exact matches if there are any, else contains matches.
     */
    private static AccessibilityNodeInfo nth(JSONObject s, List<AccessibilityNodeInfo> all) {
        List<AccessibilityNodeInfo> exact = new ArrayList<>();
        List<AccessibilityNodeInfo> partial = new ArrayList<>();
        for (AccessibilityNodeInfo n : all) {
            int m = match(n, s);
            if (m == 2) exact.add(n);
            else if (m == 1) partial.add(n);
        }
        List<AccessibilityNodeInfo> list = exact.isEmpty() ? partial : exact;
        list.sort((x, y) -> {
            Rect a = new Rect(), b = new Rect();
            x.getBoundsInScreen(a);
            y.getBoundsInScreen(b);
            return a.top != b.top ? Integer.compare(a.top, b.top) : Integer.compare(a.left, b.left);
        });
        int idx = s.optInt("index", 0);
        return idx >= 0 && idx < list.size() ? list.get(idx) : null;
    }

    /** Back closes the keyboard; waits until the system no longer lists its window. */
    private String hideKeyboard() {
        windows();
        if (!keyboardShown) return "keyboard already hidden";
        key("back");
        long deadline = SystemClock.uptimeMillis() + 1500;
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(POLL_MS);
            windows();
            if (!keyboardShown) return "hidden";
        }
        throw new IllegalStateException("keyboard still shown after back");
    }

    /** Whether b's center lies past a's edge on that side. */
    private static boolean side(String key, Rect a, Rect b) {
        switch (key) {
            case "below": return b.centerY() > a.bottom;
            case "above": return b.centerY() < a.top;
            case "leftOf": return b.centerX() < a.left;
            default: return b.centerX() > a.right;
        }
    }

    private static void flatten(AccessibilityNodeInfo n, List<AccessibilityNodeInfo> out) {
        if (n == null || !n.isVisibleToUser()) return;
        out.add(n);
        boolean[] hidden = coveredScreens(n);
        for (int i = 0; i < n.getChildCount(); i++) if (hidden == null || !hidden[i]) flatten(n.getChild(i), out);
    }

    /** 2 = exact match, 1 = contains match (text/desc only), 0 = no match. */
    private static int match(AccessibilityNodeInfo n, JSONObject s) {
        int score = 2;
        if (s.has("id")) {
            String id = n.getViewIdResourceName();
            String want = s.optString("id");
            if (id == null || !(id.equals(want) || id.endsWith("/" + want))) return 0;
        }
        if (s.has("text")) score = Math.min(score, textScore(n.getText(), n.getContentDescription(), s.optString("text")));
        if (s.has("desc")) score = Math.min(score, textScore(n.getContentDescription(), null, s.optString("desc")));
        return score;
    }

    /** "/A|B/" is a regex; cached since every node of every poll is checked against it. */
    private static final Map<String, java.util.regex.Pattern> PATTERNS = new java.util.concurrent.ConcurrentHashMap<>();

    static boolean isRegex(String want) {
        return want.length() > 2 && want.startsWith("/") && want.endsWith("/");
    }

    private static java.util.regex.Pattern pattern(String want) {
        java.util.regex.Pattern p = PATTERNS.get(want);
        if (p == null) {
            try {
                p = java.util.regex.Pattern.compile(want.substring(1, want.length() - 1),
                        java.util.regex.Pattern.CASE_INSENSITIVE | java.util.regex.Pattern.UNICODE_CASE | java.util.regex.Pattern.DOTALL);
            } catch (java.util.regex.PatternSyntaxException e) {
                throw new IllegalArgumentException("bad regex " + want + ": " + e.getDescription());
            }
            PATTERNS.put(want, p);
        }
        return p;
    }

    private static int textScore(CharSequence a, CharSequence b, String want) {
        if (isRegex(want.trim())) {
            // Like exact vs contains: the whole text matching beats a match inside it.
            java.util.regex.Pattern p = pattern(want.trim());
            int best = 0;
            for (CharSequence cs : new CharSequence[]{a, b}) {
                if (cs == null) continue;
                java.util.regex.Matcher m = p.matcher(cs.toString().trim());
                if (m.matches()) return 2;
                if (m.find()) best = 1;
            }
            return best;
        }
        String w = want.trim().toLowerCase(Locale.ROOT);
        int best = 0;
        for (CharSequence cs : new CharSequence[]{a, b}) {
            if (cs == null) continue;
            String v = cs.toString().trim().toLowerCase(Locale.ROOT);
            if (v.equals(w)) return 2;
            if (!w.isEmpty() && v.contains(w)) best = 1;
        }
        return best;
    }

    private static String describe(JSONObject s) {
        StringBuilder sb = new StringBuilder();
        for (String k : new String[]{"text", "id", "desc"}) {
            if (s.has(k)) sb.append(sb.length() > 0 ? " " : "").append(k).append("=\"").append(s.optString(k)).append('"');
        }
        if (s.has("index")) sb.append(sb.length() > 0 ? " " : "").append("index ").append(s.optInt("index"));
        for (String k : RELATIVE) {
            if (!s.has(k)) continue;
            Object v = s.opt(k);
            String a = v instanceof JSONObject ? describe((JSONObject) v) : "\"" + v + "\"";
            sb.append(sb.length() > 0 ? " " : "").append(k).append(' ').append(a);
        }
        return sb.toString();
    }

    // ---------------------------------------------------------------- actions

    private boolean inject(InputEvent ev, boolean sync) {
        try {
            if (injectNoAnimWait != null) return (Boolean) injectNoAnimWait.invoke(automation, ev, sync, false);
        } catch (Exception e) {
            System.err.println("3-arg inject failed, falling back: " + e);
        }
        return automation.injectInputEvent(ev, sync);
    }

    private boolean touch(int action, long down, long at, int x, int y, boolean sync) {
        MotionEvent ev = MotionEvent.obtain(down, at, action, x, y, 0);
        ev.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        boolean ok = inject(ev, sync);
        ev.recycle();
        return ok;
    }

    private String tap(JSONObject s, boolean longPress) throws Exception {
        int[] p = point(s);
        long down = SystemClock.uptimeMillis();
        boolean ok = touch(MotionEvent.ACTION_DOWN, down, down, p[0], p[1], true);
        if (longPress) SystemClock.sleep(s.optLong("ms", 700));
        ok &= touch(MotionEvent.ACTION_UP, down, SystemClock.uptimeMillis(), p[0], p[1], true);
        if (!ok) throw new IllegalStateException("inject failed (Xiaomi: enable 'USB debugging (Security settings)')");
        return "tapped " + p[0] + "," + p[1];
    }

    private String swipe(int x1, int y1, int x2, int y2, int ms) {
        long down = SystemClock.uptimeMillis();
        touch(MotionEvent.ACTION_DOWN, down, down, x1, y1, false);
        int steps = Math.max(ms / 16, 4);
        for (int i = 1; i < steps; i++) {
            SystemClock.sleep(ms / steps);
            float f = (float) i / steps;
            touch(MotionEvent.ACTION_MOVE, down, SystemClock.uptimeMillis(),
                    (int) (x1 + (x2 - x1) * f), (int) (y1 + (y2 - y1) * f), false);
        }
        boolean ok = touch(MotionEvent.ACTION_UP, down, SystemClock.uptimeMillis(), x2, y2, true);
        if (!ok) throw new IllegalStateException("inject failed");
        return "swiped";
    }

    /**
     * {"dir":"down"} scrolls content down (finger moves up). With "until", repeats until the
     * target is visible. Uses the accessibility scroll action on the biggest scrollable node
     * (fast, and it reports the end of the list); falls back to a swipe when there is none.
     */
    private String scroll(JSONObject s) {
        String dir = s.optString("dir", "down");
        if (!dir.matches("up|down|left|right")) throw new IllegalArgumentException("dir must be up/down/left/right");
        int max = s.optInt("max", 10);
        JSONObject until = s.optJSONObject("until");
        String how = "swipe";

        for (int i = 0; i <= max; i++) {
            if (until != null && find(until) != null) return "found after " + i + " scroll(s)";
            if (i == max) break;
            String before = observe();
            AccessibilityNodeInfo list = scrollableFor(dir);
            boolean moved = list != null && scrollAction(list, dir);
            if (moved) {
                how = "action";
            } else {
                Rect area = new Rect();
                if (list != null) list.getBoundsInScreen(area);
                else if (!windows().isEmpty()) windows().get(0).root.getBoundsInScreen(area);
                swipeIn(area, dir);
            }
            // Scroll actions are async: wait for the list to move before deciding it is at the end.
            if (!waitChange(before, 700)) {
                if (until == null) return "already at the end (" + dir + ")";
                break;
            }
            waitIdle(150, 1000);
            if (until == null) return "scrolled " + dir + " (" + how + ")";
        }
        if (until != null) throw new Missing("not found after scrolling: " + describe(until));
        return "scrolled " + dir;
    }

    /**
     * The list to scroll in the top-most window that has one: the biggest node offering the
     * directional action for `dir`, else the biggest scrollable node. Checking the direction
     * keeps "down" from paging a horizontal pager that happens to be larger.
     */
    private AccessibilityNodeInfo scrollableFor(String dir) {
        AccessibilityAction wanted = directional(dir);
        for (Win w : windows()) {
            List<AccessibilityNodeInfo> all = new ArrayList<>();
            flatten(w.root, all);
            AccessibilityNodeInfo bestDirectional = null;
            AccessibilityNodeInfo bestAny = null;
            long areaDirectional = 0;
            long areaAny = 0;
            for (AccessibilityNodeInfo n : all) {
                if (!n.isScrollable()) continue;
                Rect r = new Rect();
                n.getBoundsInScreen(r);
                long area = (long) r.width() * r.height();
                if (n.getActionList().contains(wanted) && area > areaDirectional) {
                    areaDirectional = area;
                    bestDirectional = n;
                }
                if (area > areaAny) {
                    areaAny = area;
                    bestAny = n;
                }
            }
            if (bestDirectional != null) return bestDirectional;
            if (bestAny != null) return bestAny;
        }
        return null;
    }

    private static AccessibilityAction directional(String dir) {
        switch (dir) {
            case "down": return AccessibilityAction.ACTION_SCROLL_DOWN;
            case "up": return AccessibilityAction.ACTION_SCROLL_UP;
            case "left": return AccessibilityAction.ACTION_SCROLL_LEFT;
            default: return AccessibilityAction.ACTION_SCROLL_RIGHT;
        }
    }

    /** Directional scroll actions (API 23+) when offered, else forward/backward. */
    private static boolean scrollAction(AccessibilityNodeInfo n, String dir) {
        AccessibilityAction wanted = directional(dir);
        if (n.getActionList().contains(wanted)) return n.performAction(wanted.getId());
        boolean forward = dir.equals("down") || dir.equals("right");
        return n.performAction(forward ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD);
    }

    private void swipeIn(Rect a, String dir) {
        int cx = a.centerX();
        int cy = a.centerY();
        int dy = a.height() / 4;
        int dx = a.width() / 3;
        switch (dir) {
            case "down": swipe(cx, cy + dy, cx, cy - dy, 250); break;
            case "up": swipe(cx, cy - dy, cx, cy + dy, 250); break;
            // Like down/up: "left" shows what is to the left, so the finger moves right.
            case "left": swipe(cx - dx, cy, cx + dx, cy, 250); break;
            default: swipe(cx + dx, cy, cx - dx, cy, 250); break;
        }
    }

    /** {"value":"..."} into the focused field, or first taps the field given by ref/x,y/id/desc/field (its text). */
    private static final long FOCUS_WAIT_MS = 2000;

    private String type(JSONObject s) throws Exception {
        AccessibilityNodeInfo field;
        JSONObject sel = new JSONObject();
        for (String k : new String[]{"ref", "x", "y", "id", "desc", "wait", "index", "below", "above", "leftOf", "rightOf"}) if (s.has(k)) sel.put(k, s.opt(k));
        if (s.has("field")) sel.put("text", s.optString("field"));
        if (sel.length() > (sel.has("wait") ? 1 : 0)) {
            tap(sel, false);
            SystemClock.sleep(150);
        }
        // Focus can trail the tap, e.g. on a web page that is still loading.
        long deadline = SystemClock.uptimeMillis() + FOCUS_WAIT_MS;
        field = automation.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        while ((field == null || !field.isEditable()) && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(POLL_MS);
            field = automation.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        }
        // Web fields sometimes never report input focus after a tap; focus the matched node.
        if ((field == null || !field.isEditable()) && (sel.has("text") || sel.has("id") || sel.has("desc") || hasRelative(sel))) {
            AccessibilityNodeInfo n = find(sel);
            if (n != null && n.isEditable()) {
                n.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
                field = n;
            }
        }
        if (field == null || !field.isEditable()) throw new IllegalStateException("no focused text field");
        String value = s.optString("value");
        if (s.optBoolean("append", false) && field.getText() != null) value = field.getText() + value;
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
        if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) throw new IllegalStateException("set text failed");
        if (s.optBoolean("submit", false)) key("enter");
        return "typed " + value.length() + " chars";
    }

    private String key(String name) {
        int code;
        switch (name.toLowerCase(Locale.ROOT)) {
            case "back": code = KeyEvent.KEYCODE_BACK; break;
            case "home": code = KeyEvent.KEYCODE_HOME; break;
            case "enter": code = KeyEvent.KEYCODE_ENTER; break;
            case "recents": code = KeyEvent.KEYCODE_APP_SWITCH; break;
            case "delete": code = KeyEvent.KEYCODE_DEL; break;
            case "tab": code = KeyEvent.KEYCODE_TAB; break;
            default:
                try {
                    code = Integer.parseInt(name);
                } catch (NumberFormatException e) {
                    throw new IllegalArgumentException("unknown key: " + name);
                }
        }
        long now = SystemClock.uptimeMillis();
        boolean ok = inject(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, 0, -1, 0, 0, InputDevice.SOURCE_KEYBOARD), true);
        ok &= inject(new KeyEvent(now, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, code, 0, 0, -1, 0, 0, InputDevice.SOURCE_KEYBOARD), true);
        if (!ok) throw new IllegalStateException("inject failed");
        return "pressed " + name;
    }

    // ---------------------------------------------------------------- waits

    private String waitFor(JSONObject s, boolean gone) throws Exception {
        long timeout = s.optLong("timeout", 5000);
        long deadline = SystemClock.uptimeMillis() + timeout;
        long t0 = SystemClock.uptimeMillis();
        while (true) {
            boolean present = find(s) != null;
            if (present != gone) return (gone ? "gone" : "found") + " after " + (SystemClock.uptimeMillis() - t0) + "ms";
            if (SystemClock.uptimeMillis() > deadline) {
                throw new Missing("timeout waiting for " + (gone ? "gone: " : "") + describe(s));
            }
            if (!gone && dismissAny(s)) deadline = SystemClock.uptimeMillis() + timeout;
            else SystemClock.sleep(POLL_MS);
            clearCacheEvery(CLEAR_EVERY_MS);
        }
    }

    /** True as soon as the observed tree differs from `before`, false if it stays the same for timeoutMs. */
    private boolean waitChange(String before, long timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            if (!observe().equals(before)) return true;
            SystemClock.sleep(POLL_MS);
        }
        return !observe().equals(before);
    }

    /** Waits until the observed tree stops changing for quietMs. Cheap substitute for "app is idle". */
    String waitIdle(int quietMs, int timeout) {
        long t0 = SystemClock.uptimeMillis();
        long deadline = t0 + timeout;
        String last = observe();
        long stableSince = SystemClock.uptimeMillis();
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(POLL_MS);
            String now = observe();
            if (!now.equals(last)) {
                last = now;
                stableSince = SystemClock.uptimeMillis();
            } else if (SystemClock.uptimeMillis() - stableSince >= quietMs) {
                return "idle after " + (SystemClock.uptimeMillis() - t0) + "ms";
            }
        }
        return "still changing after " + timeout + "ms";
    }

    // ---------------------------------------------------------------- screenshot

    byte[] screenshot(int max, int quality) {
        Bitmap bmp = automation.takeScreenshot();
        if (bmp == null) throw new IllegalStateException("screenshot failed (secure window?)");
        int w = bmp.getWidth();
        int h = bmp.getHeight();
        int longest = Math.max(w, h);
        if (max > 0 && longest > max) {
            float f = (float) max / longest;
            Bitmap scaled = Bitmap.createScaledBitmap(bmp, Math.round(w * f), Math.round(h * f), true);
            bmp.recycle();
            bmp = scaled;
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.JPEG, quality, out);
        bmp.recycle();
        return out.toByteArray();
    }

    private static final int CROP_PAD = 8;
    private static final int CROP_GAP = 6;

    /**
     * Crops of the given @refs from the latest observe, side by side in one JPEG in the order
     * asked, each fit into a size x size box. Lets a model see unlabeled icons for a few tokens
     * instead of a full screenshot. No "@n" text on the image: app_process has no default
     * Typeface, and drawText aborts the process.
     */
    byte[] crops(int[] wanted, int size, int quality) {
        for (int ref : wanted) if (!refs.containsKey(ref)) throw new IllegalArgumentException("unknown ref @" + ref + " (observe again)");
        Bitmap shot = automation.takeScreenshot();
        if (shot == null) throw new IllegalStateException("screenshot failed (secure window?)");
        // takeScreenshot returns a hardware bitmap, which a software Canvas cannot draw.
        Bitmap screen = shot.copy(Bitmap.Config.ARGB_8888, false);
        shot.recycle();
        Bitmap strip = Bitmap.createBitmap(wanted.length * (size + CROP_GAP) - CROP_GAP, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(strip);
        canvas.drawColor(Color.DKGRAY);
        Paint smooth = new Paint(Paint.FILTER_BITMAP_FLAG);
        for (int i = 0; i < wanted.length; i++) {
            Rect src = new Rect(refs.get(wanted[i]).bounds);
            src.inset(-CROP_PAD, -CROP_PAD);
            if (!src.intersect(0, 0, screen.getWidth(), screen.getHeight())) continue;
            float f = Math.min(1f, Math.min((float) size / src.width(), (float) size / src.height()));
            int w = Math.round(src.width() * f), h = Math.round(src.height() * f);
            int left = i * (size + CROP_GAP) + (size - w) / 2;
            int top = (size - h) / 2;
            canvas.drawBitmap(screen, src, new Rect(left, top, left + w, top + h), smooth);
        }
        screen.recycle();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        strip.compress(Bitmap.CompressFormat.JPEG, quality, out);
        strip.recycle();
        return out.toByteArray();
    }
}
