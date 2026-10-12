/**
 * The roster's presentational pieces (R1, R2, R6, R7) — one row per profile, expanding in place.
 *
 * Nothing here fetches or decides: every value arrives as a prop from `useRoster`, which is where
 * the pure modules (`rosterFeed`, `lights`, `sections`) were turned into data. That split is what
 * keeps the screen short, and it is why the shape of the roster can be tested without a renderer.
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Image, Modal, PanResponder, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { t } from '../i18n';
import { AVATAR_SIZE } from '../logic/avatars';
import type { DotState, Rollup } from '../logic/lights';
import { dotColorKey, showBadge } from '../logic/lights';
import type { RosterProfileRow, SessionRowModel } from '../logic/rosterFeed';
import { SWIPE, actionAvailability, actionLabel, clampDrag, confirmLabel, restX, rowAccessibilityActions, settle, shouldClaim } from '../logic/swipe';
import type { Surface } from '../settings';
import { rosterRowGeometry, sessionRowGeometry } from './geometry';
import { SWATCHES } from '../rosterPrefs';
import { colors, font, radius, space } from '../theme';

/** The row's numbers, derived from the reference and asserted in `tests/run.ts`. */
const G = rosterRowGeometry();

/** 0.8.0 C: the session row's own column — the dot under the face, not the profile text column. */
const S = sessionRowGeometry();

/** One profile row's shared metrics, used by the profile row AND the sessions under it. */
export const ROW_METRICS = {
  /** 62: 0.8.0 B's +15% face (was 54), and what `avatarKey()` caches. */
  avatar: AVATAR_SIZE,
  height: G.height,
  inset: G.inset,
  avatarGap: G.avatarGap,
  textX: G.textX,
  dividerInset: G.dividerInset,
};

/**
 * 0.8.0 C — what a session row is padded to: the DOT column, not the text column. Exported so the
 * wiring is checkable without a renderer, exactly like `ROW_METRICS`.
 */
export const SESSION_METRICS = {
  dotX: S.dotX,
  dotColumn: S.dotColumn,
  dotCentre: S.dotCentre,
  gap: S.gap,
  textX: S.textX,
};

export function dotColour(state: DotState): string {
  const key = dotColorKey(state);
  if (key === 'amber') return colors.amber;
  if (key === 'green') return colors.green;
  return colors.grey;
}

export function dotLabel(rollup: Rollup): string {
  if (rollup.state === 'needs-input') return t.roster.lights.waiting;
  if (rollup.state === 'unread') return t.roster.lights.unread;
  return t.roster.lights.idle;
}

/** The light: a colour, and a number only from two upwards (R7). */
export function Dot({ rollup, size = 8 }: { rollup: Rollup; size?: number }) {
  const badge = showBadge(rollup);
  return (
    <View style={styles.dotWrap} accessible accessibilityLabel={dotLabel(rollup)}>
      <View
        style={{
          width: badge ? size + 2 : size,
          height: badge ? size + 2 : size,
          borderRadius: (size + 2) / 2,
          backgroundColor: dotColour(rollup.state),
        }}
      />
      {badge ? (
        <View style={styles.dotBadge}>
          <Text style={styles.dotBadgeText}>{rollup.count}</Text>
        </View>
      ) : null}
      {rollup.fresh > 0 && !badge ? <View style={styles.freshTick} /> : null}
    </View>
  );
}

/** 62 dp face (0.8.0 B: 54 + 15%), monogram until the avatar lands — never blocking the paint (F1). */
export function Face(props: { url: string | null; monogram: string; size?: number; tint?: string | null }) {
  const size = props.size ?? AVATAR_SIZE;
  const round = { width: size, height: size, borderRadius: size / 2 };
  return (
    <View style={[styles.face, round, props.tint ? { borderColor: props.tint, borderWidth: 2 } : null]}>
      {props.url ? (
        <Image source={{ uri: props.url }} style={round} accessibilityIgnoresInvertColors />
      ) : (
        <Text style={[styles.monogram, { fontSize: Math.max(11, Math.round(size * 0.42)) }]}>{props.monogram}</Text>
      )}
    </View>
  );
}

export function SearchBar(props: { value: string; onChange: (value: string) => void; onClear: () => void; busy: boolean }) {
  return (
    <View style={styles.searchRow}>
      <Ionicons name="search-outline" size={16} color={colors.muted} />
      <TextInput
        value={props.value}
        onChangeText={props.onChange}
        placeholder={t.roster.searchPlaceholder}
        placeholderTextColor={colors.faint}
        style={styles.searchInput}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel={t.roster.searchPlaceholder}
      />
      {props.busy ? <ActivityIndicator size="small" color={colors.muted} /> : null}
      {props.value ? (
        <Pressable onPress={props.onClear} accessibilityRole="button" accessibilityLabel={t.roster.searchClear} hitSlop={8}>
          <Ionicons name="close-circle" size={16} color={colors.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** A group heading: collapsible, and it explains itself when it is empty. */
export function SectionHeader(props: {
  name: string;
  count: number;
  collapsed: boolean;
  canManage: boolean;
  onToggle: () => void;
  onMenu?: () => void;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Pressable
        onPress={props.onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: !props.collapsed }}
        style={({ pressed }) => [styles.sectionToggle, pressed && styles.pressed]}
      >
        <Ionicons name={props.collapsed ? 'chevron-forward' : 'chevron-down'} size={14} color={colors.muted} />
        <Text style={styles.sectionName} numberOfLines={1}>
          {props.name}
        </Text>
        <Text style={styles.sectionCount}>{props.count}</Text>
      </Pressable>
      {props.canManage && props.onMenu ? (
        <Pressable
          onPress={props.onMenu}
          accessibilityRole="button"
          accessibilityLabel={`${props.name} — ${t.roster.menu.title}`}
          hitSlop={8}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        >
          <Ionicons name="ellipsis-horizontal" size={14} color={colors.faint} />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * One profile: face, name, preview of its LATEST CONVERSATION, age, light, unread count, and a
 * caret that says whether its sessions are open underneath. Tapping the body expands in place
 * (R2); the long press is mobile's right-click (R8).
 */
export function ProfileRow(props: {
  row: RosterProfileRow;
  avatarUrl: string | null;
  monogram: string;
  actionLabel: string;
  onToggle: () => void;
  onOpenLast: () => void;
  onMenu: () => void;
}) {
  const { row } = props;
  const tint = row.color;
  return (
    <View style={tint ? { borderLeftColor: tint, borderLeftWidth: 3 } : null}>
      <Pressable
        onPress={props.onToggle}
        onLongPress={props.onMenu}
        delayLongPress={350}
        accessibilityRole="button"
        accessibilityState={{ expanded: row.expanded }}
        accessibilityLabel={`${row.label}${row.preview ? `, ${row.preview}` : ''}`}
        style={({ pressed }) => [styles.profileBody, pressed && styles.rowPressed]}
      >
        <Face url={props.avatarUrl} monogram={props.monogram} tint={tint} />
        <View style={styles.profileText}>
          <View style={styles.profileTitleLine}>
            <Text style={[styles.profileName, row.hidden && styles.hiddenName]} numberOfLines={1}>
              {row.label}
            </Text>
            {row.isDefault ? <Text style={styles.defaultChip}>default</Text> : null}
            {row.dot.fresh > 0 ? (
              <View style={styles.newPill}>
                <Text style={styles.newPillText}>{row.dot.fresh}</Text>
              </View>
            ) : null}
            <Dot rollup={row.dot} />
          </View>
          {row.expanded ? null : (
            <Text style={styles.profilePreview} numberOfLines={1}>
              {row.preview || t.roster.noSessions}
            </Text>
          )}
        </View>
        {!row.expanded ? <Text style={styles.age}>{row.age}</Text> : null}
        <Ionicons name={row.expanded ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.faint} />
      </Pressable>
      {props.actionLabel && row.expanded && row.sessions.length ? (
        <Pressable
          onPress={props.onOpenLast}
          onLongPress={props.onMenu}
          accessibilityRole="button"
          accessibilityLabel={`${t.roster.menu.open} — ${props.actionLabel}`}
          style={({ pressed }) => [styles.openLast, pressed && styles.pressed]}
        >
          <Text style={styles.openLastText} numberOfLines={1}>
            {props.actionLabel}
          </Text>
        </Pressable>
      ) : null}
      {/* The divider is DERIVED to clear the avatar (max(78, 16 + 62) = 78), so the row still
          reads as one cell — 76 dp since 0.8.0 A. */}
      <View style={styles.divider} />
    </View>
  );
}

/**
 * One session under its profile: light, title, preview, age — padded to the DOT column since 0.8.0
 * C, so the list reads less indented and the dot lands under the face.
 *
 * 0.8.0 E: sliding the row left reveals **archive** (blue) and **delete** (red trash, two-step
 * confirm). The pixels live here (`Animated.Value` + `PanResponder`); every DECISION — the claim
 * predicate, the settle rule, which row is open, the arming — lives in `src/logic/swipe.ts`, which
 * is what makes the feature testable without a phone. The list owns "which row is open" so exactly
 * one can be revealed at a time.
 *
 * No new native dependency: `PanResponder` is core React Native, and the claim predicate requires a
 * clearly horizontal slide, so the `FlatList` keeps its vertical scroll.
 */
export function SessionRow(props: {
  model: SessionRowModel;
  automatic: boolean;
  /** Which surface — the gateway says `501` for both verbs, so the buttons render disabled. */
  surface: Surface;
  /** This row is the ONE revealed row. */
  open: boolean;
  /** This row's delete is armed for the confirm. */
  armed: boolean;
  onOpenRow: () => void;
  onCloseRow: () => void;
  onArchive: () => void;
  onArmDelete: () => void;
  onConfirmDelete: () => void;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const { model } = props;
  /** The latest props, so the gesture handlers created once are never stale. */
  const latest = useRef(props);
  latest.current = props;
  const translateX = useRef(new Animated.Value(restX(props.open))).current;

  // The reveal is animated, not sprung by the gesture: opening a row from another row's gesture
  // still slides this one shut.
  useEffect(() => {
    Animated.spring(translateX, { toValue: restX(props.open), useNativeDriver: true, bounciness: 0, speed: 18 }).start();
  }, [props.open, translateX]);

  const pan = useRef(
    PanResponder.create({
      // A tap never opens a row and a vertical scroll is never eaten: both rules are in `shouldClaim`.
      onMoveShouldSetPanResponder: (_event, gesture) => shouldClaim(gesture.dx, gesture.dy),
      // Once claimed, keep it — the list must not steal a slide halfway through.
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_event, gesture) => {
        const base = restX(latest.current.open);
        translateX.setValue(clampDrag(base + gesture.dx));
      },
      onPanResponderRelease: (_event, gesture) => {
        const base = restX(latest.current.open);
        const landed = settle(base + gesture.dx, gesture.vx);
        if (landed === 'open') latest.current.onOpenRow();
        else latest.current.onCloseRow();
      },
      onPanResponderTerminate: () => {
        if (!latest.current.open) latest.current.onCloseRow();
      },
    }),
  ).current;

  const rollup: Rollup = { state: model.state, count: 0, counts: { 'needs-input': 0, unread: 0, idle: 0 }, fresh: 0 };
  const archive = actionAvailability(props.surface, 'archive');
  const remove = actionAvailability(props.surface, 'delete');
  const buttonWidth = SWIPE.revealWidth / 2;

  return (
    <View style={styles.swipeWrap}>
      {/* The revealed verbs sit UNDER the row and are inert until the row is actually open — a
          button you cannot see must not be tappable. */}
      <View
        style={[styles.swipeActions, { width: SWIPE.revealWidth }]}
        pointerEvents={props.open ? 'auto' : 'none'}
      >
        <Pressable
          onPress={props.onArchive}
          disabled={!archive.enabled}
          accessibilityRole="button"
          accessibilityState={{ disabled: !archive.enabled }}
          accessibilityLabel={archive.enabled ? actionLabel('archive') : `${actionLabel('archive')} — ${archive.reason}`}
          style={({ pressed }) => [
            styles.swipeButton,
            { width: buttonWidth, backgroundColor: colors.archive },
            !archive.enabled && styles.swipeOff,
            pressed && styles.pressed,
          ]}
        >
          <Ionicons name="archive-outline" size={18} color={colors.accentText} />
          <Text style={styles.swipeButtonText}>{actionLabel('archive')}</Text>
          {archive.enabled ? null : (
            <Text style={styles.swipeReason} numberOfLines={3}>
              {archive.reason}
            </Text>
          )}
        </Pressable>

        <Pressable
          onPress={props.armed ? props.onConfirmDelete : props.onArmDelete}
          disabled={!remove.enabled}
          accessibilityRole="button"
          accessibilityState={{ disabled: !remove.enabled }}
          accessibilityLabel={
            remove.enabled
              ? props.armed
                ? `${confirmLabel()} — ${t.roster.swipe.confirmDelete}`
                : actionLabel('delete')
              : `${actionLabel('delete')} — ${remove.reason}`
          }
          style={({ pressed }) => [
            styles.swipeButton,
            { width: buttonWidth, backgroundColor: props.armed ? colors.amber : colors.red },
            !remove.enabled && styles.swipeOff,
            pressed && styles.pressed,
          ]}
        >
          <Ionicons name={props.armed ? 'alert-circle-outline' : 'trash-outline'} size={18} color={colors.accentText} />
          <Text style={styles.swipeButtonText}>{props.armed ? confirmLabel() : actionLabel('delete')}</Text>
          {props.armed ? (
            <Text style={styles.swipeReason} numberOfLines={3}>
              {t.roster.swipe.confirmDelete}
            </Text>
          ) : null}
          {remove.enabled ? null : (
            <Text style={styles.swipeReason} numberOfLines={3}>
              {remove.reason}
            </Text>
          )}
        </Pressable>
      </View>

      <Animated.View style={[styles.swipeSurface, { transform: [{ translateX }] }]} {...pan.panHandlers}>
        <Pressable
          onPress={props.open ? props.onCloseRow : props.onOpen}
          onLongPress={props.onMenu}
          delayLongPress={350}
          accessibilityRole="button"
          accessibilityLabel={model.title}
          accessibilityHint={props.open ? undefined : t.roster.swipe.a11yHint}
          // Both verbs stay reachable WITHOUT a gesture (this, and the long-press menu above).
          accessibilityActions={rowAccessibilityActions(props.surface)}
          onAccessibilityAction={(event) => {
            const name = event.nativeEvent.actionName;
            if (name === 'archive') props.onArchive();
            else if (name === 'delete') {
              // The same two-step rule: the first activation arms and says what it does.
              if (props.armed) props.onConfirmDelete();
              else props.onArmDelete();
            }
          }}
          style={({ pressed }) => [
            styles.sessionRow,
            model.color ? { borderLeftColor: model.color, borderLeftWidth: 2 } : null,
            pressed && styles.rowPressed,
          ]}
        >
          <View style={styles.sessionDot}>
            {props.automatic ? <Ionicons name="time-outline" size={12} color={colors.faint} /> : <Dot rollup={rollup} size={7} />}
          </View>
          <View style={styles.sessionText}>
            <Text style={styles.sessionTitle} numberOfLines={1}>
              {model.title}
            </Text>
            {model.preview ? (
              <Text style={styles.sessionPreview} numberOfLines={1}>
                {model.preview}
              </Text>
            ) : null}
          </View>
          {props.automatic ? <Text style={styles.autoChip}>{t.roster.automatic}</Text> : null}
          <Text style={styles.age}>{model.age || model.date}</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

/** The swatch row the colour verbs open: the palette, plus "no fill" as a real option. */
export function SwatchPicker(props: { value: string | null; onPick: (colour: string | null) => void }) {
  return (
    <View style={styles.swatchRow}>
      <Pressable
        onPress={() => props.onPick(null)}
        accessibilityRole="button"
        accessibilityLabel={t.roster.menu.colourNone}
        style={[styles.swatch, styles.swatchNone, !props.value && styles.swatchActive]}
      >
        <Ionicons name="ban-outline" size={14} color={colors.muted} />
      </Pressable>
      {SWATCHES.map((swatch) => (
        <Pressable
          key={swatch}
          onPress={() => props.onPick(swatch)}
          accessibilityRole="button"
          accessibilityLabel={swatch}
          style={[styles.swatch, { backgroundColor: swatch }, props.value === swatch && styles.swatchActive]}
        />
      ))}
    </View>
  );
}


/**
 * Mobile's answer to the desktop's right-click menu (R8): a bottom sheet of icons + PT-PT labels.
 *
 * The entries come from `menus.ts`, so the verbs are data — an action that silently disappears is a
 * failing test rather than a surprise on a phone. `children` carries whatever the picked verb needs
 * next (the swatch palette, the group list) without inventing a second sheet.

 */
export function ActionSheet(props: {
  visible: boolean;
  title: string;
  /**
   * `disabled` + `reason` exist for 0.7.0's "+": a verb that cannot work right now is shown, dimmed,
   * with the sentence explaining why — never hidden and never a silent no-op.
   */
  entries: { key: string; label: string; icon: string; destructive?: boolean; disabled?: boolean; reason?: string }[];
  labelOf: (key: string) => string;
  onPick: (key: string) => void;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={props.onClose} accessibilityRole="button" accessibilityLabel={t.common.close}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <Text style={styles.sheetTitle} numberOfLines={1}>
            {props.title}
          </Text>
          {props.entries.map((entry) => (
            <Pressable
              key={entry.key}
              onPress={() => props.onPick(entry.key)}
              disabled={entry.disabled}
              accessibilityRole="button"
              accessibilityState={{ disabled: Boolean(entry.disabled) }}
              accessibilityLabel={
                entry.reason ? `${props.labelOf(entry.label)} — ${entry.reason}` : props.labelOf(entry.label)
              }
              style={({ pressed }) => [styles.sheetRow, pressed && styles.rowPressed, entry.disabled && styles.disabledRow]}
            >
              <Ionicons
                name={entry.icon as never}
                size={18}
                color={entry.disabled ? colors.faint : entry.destructive ? colors.red : colors.text}
              />
              <View style={styles.sheetLabelWrap}>
                <Text
                  style={[styles.sheetLabel, entry.destructive && styles.sheetLabelDanger, entry.disabled && styles.sheetLabelOff]}
                  numberOfLines={1}
                >
                  {props.labelOf(entry.label)}
                </Text>
                {entry.reason ? (
                  <Text style={styles.sheetReason} numberOfLines={2}>
                    {entry.reason}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          ))}
          {props.children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * A text prompt. `Alert.prompt` is iOS-only, so the roster carries its own — rename, new group and
 * new session all need one, and a platform-conditional dialog would be two different apps.

 */
export function PromptSheet(props: {
  visible: boolean;
  title: string;
  placeholder?: string;
  value: string;
  onChangeText: (value: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  onClose: () => void;
}) {
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={props.onClose} accessibilityRole="button" accessibilityLabel={t.common.close}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <Text style={styles.sheetTitle}>{props.title}</Text>
          <TextInput
            value={props.value}
            onChangeText={props.onChangeText}
            placeholder={props.placeholder}
            placeholderTextColor={colors.faint}
            style={styles.promptInput}
            autoFocus
            autoCapitalize="sentences"
          />
          <View style={styles.promptActions}>
            <Pressable onPress={props.onSubmit} style={({ pressed }) => [styles.primarySm, pressed && styles.pressed]}>
              <Text style={styles.primarySmText}>{props.submitLabel}</Text>
            </Pressable>
            <Pressable onPress={props.onClose} style={({ pressed }) => [styles.secondarySm, pressed && styles.pressed]}>
              <Text style={styles.secondarySmText}>{t.roster.menu.cancel}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.panel,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    gap: 2,
    maxHeight: '80%',
  },
  sheetTitle: { color: colors.text, fontSize: font.body, fontWeight: '700', paddingBottom: space.sm },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, borderRadius: radius.sm },
  sheetLabel: { color: colors.text, fontSize: font.body, flex: 1 },
  sheetLabelDanger: { color: colors.red },
  sheetLabelWrap: { flex: 1, gap: 2 },
  sheetLabelOff: { color: colors.faint },
  sheetReason: { color: colors.amber, fontSize: font.small, lineHeight: 16 },
  disabledRow: { opacity: 0.85 },
  promptInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  promptActions: { flexDirection: 'row', gap: space.sm, paddingTop: space.sm },
  primarySm: {
    height: 40,
    minWidth: 110,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primarySmText: { color: colors.accentText, fontWeight: '700', fontSize: font.body },
  secondarySm: {
    height: 40,
    minWidth: 90,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondarySmText: { color: colors.muted, fontWeight: '600', fontSize: font.body },
  dotWrap: { flexDirection: 'row', alignItems: 'center', gap: 3, minWidth: 10 },
  dotBadge: {
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    paddingHorizontal: 3,
    backgroundColor: colors.panelAlt,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotBadgeText: { color: colors.text, fontSize: 9, fontWeight: '700' },
  freshTick: { width: 4, height: 4, borderRadius: 2, backgroundColor: colors.accent },
  face: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.panelAlt,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  monogram: { color: colors.muted, fontWeight: '700' },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.md,
    marginBottom: space.sm,
    paddingHorizontal: space.sm,
    height: 38,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: font.body, paddingVertical: 0 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingTop: space.md,
    paddingBottom: 4,
  },
  sectionToggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  sectionName: {
    color: colors.faint,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sectionCount: { color: colors.faint, fontSize: 11, fontVariant: ['tabular-nums'] },
  iconButton: { padding: 4, borderRadius: radius.sm },
  /** A row's divider: full width, inset past the avatar (the reference's x = 78). */
  divider: { height: 1, backgroundColor: colors.border, marginLeft: ROW_METRICS.dividerInset },
  profileBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_METRICS.avatarGap,
    minHeight: ROW_METRICS.height,
    paddingHorizontal: ROW_METRICS.inset,
    paddingVertical: G.paddingVertical,
  },
  rowPressed: { backgroundColor: colors.panel },
  profileText: { flex: 1, gap: 2 },
  profileTitleLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  profileName: { color: colors.text, fontSize: G.titleSize, lineHeight: G.linePitch, fontWeight: '600', flexShrink: 1 },
  hiddenName: { color: colors.muted, fontStyle: 'italic' },
  defaultChip: {
    color: colors.faint,
    fontSize: 9,
    textTransform: 'uppercase',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 4,
  },
  newPill: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: radius.pill, backgroundColor: colors.accent },
  newPillText: { color: colors.accentText, fontSize: 10, fontWeight: '700' },
  profilePreview: { color: colors.muted, fontSize: G.previewSize, lineHeight: G.linePitch },
  age: { color: colors.faint, fontSize: 11, width: G.ageWidth, textAlign: 'right' },
  openLast: {
    marginLeft: ROW_METRICS.textX,
    marginRight: space.md,
    marginBottom: space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    backgroundColor: colors.panelAlt,
    alignSelf: 'flex-start',
    maxWidth: '70%',
  },
  openLastText: { color: colors.accent, fontSize: font.small, fontWeight: '600' },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SESSION_METRICS.gap,
    // 0.8.0 C: the DOT column, not the profile's text column — the list reads less indented, and the
    // dot lands under the face (centre 37 vs the face's 43, i.e. 6 dp left of it).
    paddingLeft: SESSION_METRICS.dotX,
    paddingRight: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sessionDot: { width: SESSION_METRICS.dotColumn, alignItems: 'center' },
  // ── 0.8.0 E: the swipe reveal ───────────────────────────────────────────────
  /** Holds the row and, behind it, the two revealed verbs. Clipped so nothing bleeds sideways. */
  swipeWrap: { overflow: 'hidden' },
  swipeActions: { position: 'absolute', right: 0, top: 0, bottom: 0, flexDirection: 'row' },
  swipeButton: { alignItems: 'center', justifyContent: 'center', gap: 2, paddingHorizontal: 4 },
  swipeButtonText: { color: colors.accentText, fontSize: 11, fontWeight: '700' },
  swipeReason: { color: colors.accentText, fontSize: 9, textAlign: 'center', opacity: 0.9 },
  /** A verb this surface cannot run: still visible, clearly off, carrying the reason. */
  swipeOff: { opacity: 0.5 },
  /** The row itself rides on this, so the actions stay hidden until it slides. */
  swipeSurface: { backgroundColor: colors.bg },
  sessionText: { flex: 1, gap: 1 },
  sessionTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  sessionPreview: { color: colors.muted, fontSize: font.small },
  autoChip: {
    color: colors.faint,
    fontSize: 9,
    textTransform: 'uppercase',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 4,
  },
  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingVertical: space.sm },
  swatch: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchNone: { backgroundColor: colors.panelAlt, borderColor: colors.border },
  swatchActive: { borderColor: colors.text },
  pressed: { opacity: 0.8 },
});
