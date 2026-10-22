package dev.droidreplay.agent;

import android.app.UiAutomation;
import android.graphics.Bitmap;
import android.graphics.Rect;
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
        final String id;       // short resource id (after ":id/"), or null
        final String text;     // first label part, or null
        final boolean ownText; // text comes from the node itself, not a folded-in child

        Ref(int x, int y, String id, String text, boolean ownText) {
            this.x = x;
            this.y = y;
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

    JSONObject run(JSONArray steps, boolean stopOnError) throws Exception {
        long t0 = SystemClock.uptimeMillis();
        JSONArray results = new JSONArray();
        boolean allOk = true;
        for (int i = 0; i < steps.length(); i++) {
            JSONObject step = steps.getJSONObject(i);
            String op = step.optString("op");
            long s0 = SystemClock.uptimeMillis();
            JSONObject r = new JSONObject().put("op", op);
            lastSel = null;
            try {
                r.put("ok", true).put("out", exec(op, step));
                if (lastSel != null) r.put("sel", lastSel);
            } catch (Exception e) {
                allOk = false;
                r.put("ok", false).put("error", e.getMessage() != null ? e.getMessage() : e.toString());
            }
            r.put("ms", SystemClock.uptimeMillis() - s0);
            results.put(r);
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

    String observe() {
        List<Win> wins = windows();
        refs.clear();
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
            walk(w.root, sb, false);
        }
        return sb.toString();
    }

    /**
     * One line per node worth knowing about. Text inside a clickable node is folded into that
     * node's label, so an icon + title + container shows up once instead of three times.
     */
    private void walk(AccessibilityNodeInfo n, StringBuilder sb, boolean absorbed) {
        if (n == null || !n.isVisibleToUser()) return;
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
            Rect r = new Rect();
            n.getBoundsInScreen(r);
            int ref = refs.size();
            String shortId = n.getViewIdResourceName();
            if (shortId != null) shortId = shortId.substring(shortId.indexOf('/') + 1);
            Set<String> own = new LinkedHashSet<>();
            addText(n, own);
            String firstPart = label.isEmpty() ? null : label.split(" · ")[0];
            refs.put(ref, new Ref(r.centerX(), r.centerY(), shortId, firstPart, !own.isEmpty()));
            sb.append('@').append(ref).append(' ').append(shortClass(n.getClassName()));
            if (!label.isEmpty()) sb.append(" \"").append(label).append('"');
            String id = n.getViewIdResourceName();
            if (id != null) sb.append(" #").append(id.substring(id.indexOf('/') + 1));
            if (n.isEditable() && n.getHintText() != null && n.getHintText().length() > 0) {
                sb.append(" hint=\"").append(n.getHintText()).append('"');
            }
            sb.append(" [").append(r.centerX()).append(',').append(r.centerY()).append(']');
            if (n.isClickable()) sb.append(" tap");
            if (n.isEditable()) sb.append(" edit");
            if (n.isScrollable()) sb.append(" scroll");
            if (n.isCheckable()) sb.append(n.isChecked() ? " on" : " off");
            if (n.isSelected()) sb.append(" selected");
            if (!n.isEnabled()) sb.append(" disabled");
            sb.append('\n');
        }
        // Children of a pressable node had their text folded in above; only their own actions show.
        boolean childAbsorbed = absorbed || pressable;
        for (int i = 0; i < n.getChildCount(); i++) walk(n.getChild(i), sb, childAbsorbed);
    }

    private static void addText(AccessibilityNodeInfo n, Set<String> parts) {
        CharSequence t = n.getText();
        CharSequence d = n.getContentDescription();
        if (t != null && t.toString().trim().length() > 0) parts.add(t.toString().trim());
        if (d != null && d.toString().trim().length() > 0) parts.add(d.toString().trim());
    }

    private static void collectText(AccessibilityNodeInfo n, Set<String> parts) {
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo c = n.getChild(i);
            if (c == null || !c.isVisibleToUser()) continue;
            if (c.isClickable() || c.isCheckable()) continue; // gets its own line
            addText(c, parts);
            collectText(c, parts);
        }
    }

    private static String join(Set<String> parts) {
        String s = String.join(" · ", parts).replace('\n', ' ').replace("\"", "'");
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
        long deadline = SystemClock.uptimeMillis() + s.optLong("wait", 0);
        while (n == null && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(POLL_MS);
            n = find(s);
        }
        if (n == null) throw new IllegalArgumentException("not found: " + describe(s));
        lastSel = new JSONObject();
        for (String k : new String[]{"text", "id", "desc"}) if (s.has(k)) lastSel.put(k, s.optString(k));
        AccessibilityNodeInfo target = n;
        // Text usually sits on a child of the thing that is actually clickable.
        while (target != null && !target.isClickable() && !target.isEditable()) target = target.getParent();
        if (target == null) target = n;
        Rect r = new Rect();
        target.getBoundsInScreen(r);
        return new int[]{r.centerX(), r.centerY()};
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

    private AccessibilityNodeInfo find(JSONObject s) {
        if (!s.has("text") && !s.has("id") && !s.has("desc")) {
            throw new IllegalArgumentException("selector needs ref, x/y, text, id or desc");
        }
        List<AccessibilityNodeInfo> all = new ArrayList<>();
        for (Win w : windows()) flatten(w.root, all);
        AccessibilityNodeInfo partial = null;
        for (AccessibilityNodeInfo n : all) {
            int m = match(n, s);
            if (m == 2) return n;
            if (m == 1 && partial == null) partial = n;
        }
        return partial;
    }

    private static void flatten(AccessibilityNodeInfo n, List<AccessibilityNodeInfo> out) {
        if (n == null || !n.isVisibleToUser()) return;
        out.add(n);
        for (int i = 0; i < n.getChildCount(); i++) flatten(n.getChild(i), out);
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

    private static int textScore(CharSequence a, CharSequence b, String want) {
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
        if (until != null) throw new IllegalStateException("not found after scrolling: " + describe(until));
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
            case "left": swipe(cx + dx, cy, cx - dx, cy, 250); break;
            default: swipe(cx - dx, cy, cx + dx, cy, 250); break;
        }
    }

    /** {"value":"..."} into the focused field, or first taps the field given by ref/x,y/id/desc/field (its text). */
    private String type(JSONObject s) throws Exception {
        AccessibilityNodeInfo field;
        JSONObject sel = new JSONObject();
        for (String k : new String[]{"ref", "x", "y", "id", "desc", "wait"}) if (s.has(k)) sel.put(k, s.opt(k));
        if (s.has("field")) sel.put("text", s.optString("field"));
        if (sel.length() > (sel.has("wait") ? 1 : 0)) {
            tap(sel, false);
            SystemClock.sleep(150);
        }
        field = automation.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
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

    private String waitFor(JSONObject s, boolean gone) {
        long deadline = SystemClock.uptimeMillis() + s.optLong("timeout", 5000);
        long t0 = SystemClock.uptimeMillis();
        while (true) {
            boolean present = find(s) != null;
            if (present != gone) return (gone ? "gone" : "found") + " after " + (SystemClock.uptimeMillis() - t0) + "ms";
            if (SystemClock.uptimeMillis() > deadline) {
                throw new IllegalStateException("timeout waiting for " + (gone ? "gone: " : "") + describe(s));
            }
            SystemClock.sleep(POLL_MS);
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
}
