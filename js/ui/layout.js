// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

/**
 * FILE:layout.js
 * @short_description: The file responsible for managing Cinnamon chrome
 */
const Clutter = imports.gi.Clutter;
const Cinnamon = imports.gi.Cinnamon;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Signals = imports.signals;
const St = imports.gi.St;
const Main = imports.ui.main;
const Params = imports.misc.params;
const Tweener = imports.ui.tweener;
const EdgeFlip = imports.ui.edgeFlip;
const HotCorner = imports.ui.hotCorner;
const DeskletManager = imports.ui.deskletManager;
const Panel = imports.ui.panel;
const {findIndex, map} = imports.misc.util;

const STARTUP_ANIMATION_TIME = 0.5;

function Monitor(index, geometry) {
    this._init(index, geometry);
}

Monitor.prototype = {
    _init: function(index, geometry) {
        this.index = index;
        this.x = geometry.x;
        this.y = geometry.y;
        this.width = geometry.width;
        this.height = geometry.height;
    },

    get inFullscreen() {
        return global.screen.get_monitor_in_fullscreen(this.index);
    }
};

function intersect (dest, src2) {
    let dest_x, dest_y;
    let dest_w, dest_h;

    dest_x = Math.max(dest.x, src2.x);
    dest_y = Math.max(dest.y, src2.y);
    dest_w = Math.min(dest.x + dest.width, src2.x + src2.width) - dest_x;
    dest_h = Math.min(dest.y + dest.height, src2.y + src2.height) - dest_y;

    if (dest_w > 0 && dest_h > 0) {
        dest.x = dest_x;
        dest.y = dest_y;
        dest.width = dest_w;
        dest.height = dest_h;
        return dest;
    }

    dest.width = 0;
    dest.height = 0;

    return dest;
}

/**
 * #LayoutManager
 *
 * @short_description: Manager of Cinnamon Chrome
 *
 * Creates and manages the Chrome container which holds
 * all of the Cinnamon UI actors.
 */
function LayoutManager() {
    this._init.apply(this, arguments);
}

LayoutManager.prototype = {
    _init: function () {
        this._rtl = (St.Widget.get_default_direction() == St.TextDirection.RTL);
        this.monitors = [];
        this.primaryMonitor = null;
        this.primaryIndex = -1;
        this.hotCornerManager = null;
        this.edgeRight = null;
        this.edgeLeft = null;
        this.hideIdleId = 0;
        this._chrome = new Chrome(this);

        this.enabledEdgeFlip = global.settings.get_boolean("enable-edge-flip");
        this.edgeFlipDelay = global.settings.get_int("edge-flip-delay");

        this.keyboardBox = new St.BoxLayout({ name: 'keyboardBox',
                                              reactive: true,
                                              track_hover: true });
        this.keyboardBox.hide();

        this.addChrome(this.keyboardBox, { visibleInFullscreen: true, affectsStruts: false });

        this._keyboardHeightNotifyId = 0;

        this._monitorsChanged();

        global.settings.connect("changed::enable-edge-flip", () => this._onEdgeFlipChanged());
        global.settings.connect("changed::edge-flip-delay", () => this._onEdgeFlipChanged());
        global.screen.connect('monitors-changed', () => this._monitorsChanged());
    },

    _onEdgeFlipChanged: function(){
        this.enabledEdgeFlip = global.settings.get_boolean("enable-edge-flip");
        this.edgeFlipDelay = global.settings.get_int("edge-flip-delay");
        this.edgeRight.enabled = this.enabledEdgeFlip;
        this.edgeRight.delay = this.edgeFlipDelay;
        this.edgeLeft.enabled = this.enabledEdgeFlip;
        this.edgeLeft.delay = this.edgeFlipDelay;
    },

    // This is called by Main after everything else is constructed;
    // Certain functions need to access other Main elements that do
    // not exist yet when the LayoutManager was constructed.
    init: function() {
        this._chrome.init();

        this.edgeRight = new EdgeFlip.EdgeFlipper(St.Side.RIGHT, Main.wm.actionFlipWorkspaceRight);
        this.edgeLeft = new EdgeFlip.EdgeFlipper(St.Side.LEFT, Main.wm.actionFlipWorkspaceLeft);

        this.edgeRight.enabled = this.enabledEdgeFlip;
        this.edgeRight.delay = this.edgeFlipDelay;
        this.edgeLeft.enabled = this.enabledEdgeFlip;
        this.edgeLeft.delay = this.edgeFlipDelay;

        this.hotCornerManager = new HotCorner.HotCornerManager();
    },

    _toggleExpo: function() {
        if (Main.expo.animationInProgress)
            return;

        if (Main.overview.visible) {
            this._activationTime = Date.now() / 1000;
            Main.overview.hide();
        }
        Main.expo.toggle();
    },

    _updateMonitors: function() {
        let screen = global.screen;

        this.monitors = [];
        let nMonitors = screen.get_n_monitors();
        for (let i = 0; i < nMonitors; i++)
            this.monitors.push(new Monitor(i, screen.get_monitor_geometry(i)));

        this.primaryIndex = screen.get_primary_monitor();
        this.primaryMonitor = this.monitors[this.primaryIndex];
    },

    _updateBoxes: function() {
        if (this.hotCornerManager)
            this.hotCornerManager.updatePosition(this.primaryMonitor);
        this._chrome._queueUpdateRegions();
    },

    _monitorsChanged: function() {
        this._updateMonitors();
        this._updateBoxes();
        this.emit('monitors-changed');
    },

    get focusIndex() {
        let i = 0;
        if (global.stage.key_focus != null)
            i = this.findMonitorIndexForActor(global.stage.key_focus);
        else if (global.display.focus_window != null)
            i = global.display.focus_window.get_monitor();
        return i;
    },

    get focusMonitor() {
        return this.monitors[this.focusIndex];
    },

    get currentMonitor() {
        let index = global.screen.get_current_monitor();
        return Main.layoutManager.monitors[index];
    },

    _prepareStartupAnimation: function() {
        // During the initial transition, add a simple actor to block all events,
        // so they don't get delivered to X11 windows that have been transformed.
        this._coverPane = new Clutter.Actor({ opacity: 0,
                                              width: global.screen_width,
                                              height: global.screen_height,
                                              reactive: true });
        this.addChrome(this._coverPane);

        // We need to force an update of the regions now before we scale
        // the UI group to get the correct allocation for the struts.
        this._chrome.updateRegions();

        this.keyboardBox.hide();

        let monitor = this.primaryMonitor;
        let x = monitor.x + monitor.width / 2.0;
        let y = monitor.y + monitor.height / 2.0;

        Main.uiGroup.set_pivot_point(x / global.screen_width,
                                     y / global.screen_height);
        Main.uiGroup.scale_x = Main.uiGroup.scale_y = 0.75;
        Main.uiGroup.opacity = 0;
        global.background_actor.show();
        global.window_group.set_clip(monitor.x, monitor.y, monitor.width, monitor.height);
    },

    _startupAnimation: function() {
        // Don't animate the strut
        this._chrome.freezeUpdateRegions();
        Tweener.addTween(Main.uiGroup,
                         { scale_x: 1,
                           scale_y: 1,
                           opacity: 255,
                           time: STARTUP_ANIMATION_TIME,
                           transition: 'easeOutQuad',
                           onComplete: this._startupAnimationComplete,
                           onCompleteScope: this });
    },

    _startupAnimationComplete: function() {
        global.stage.no_clear_hint = true;
        this._coverPane.destroy();
        this._coverPane = null;

        global.window_group.remove_clip();
        this._chrome.thawUpdateRegions();

        Main.setRunState(Main.RunState.RUNNING);
    },

    showKeyboard: function () {
        if (Main.messageTray) Main.messageTray.hide();
        if (this.hideIdleId > 0) {
            Mainloop.source_remove(this.hideIdleId);
            this.hideIdleId = 0;
        }

        if (!this.keyboardBox.visible) {
            this.keyboardBox.show();
        }

        // this.keyboardBox.raise_top();
        Main.panelManager.lowerActorBelowPanels(this.keyboardBox);

        // Poke Chrome to update the input shape; it doesn't notice
        // anchor point changes
        this._chrome.modifyActorParams(this.keyboardBox, { affectsStruts: true });
        this._chrome.updateRegions();

        this._keyboardHeightNotifyId = this.keyboardBox.connect('notify::height', () => {
            if (this.keyboardBox.y) {
                this.keyboardBox.y = this.focusMonitor.y + this.focusMonitor.height - this.keyboardBox.height;
            }
        });

    },

    queueHideKeyboard: function() {
        if (this.hideIdleId) {
            Mainloop.source_remove(this.hideIdleId);
            this.hideIdleId = 0;
        }

        if (this._keyboardHeightNotifyId) {
            this.keyboardBox.disconnect(this._keyboardHeightNotifyId);
            this._keyboardHeightNotifyId = 0;
        }

        this.hideIdleId = Mainloop.idle_add(() => this.hideKeyboard());
    },

    hideKeyboard: function () {
        if (Main.messageTray) Main.messageTray.hide();

        this.keyboardBox.hide();
        this._chrome.modifyActorParams(this.keyboardBox, { affectsStruts: false });
        this._chrome.updateRegions(true);

        this.hideIdleId = 0;
        return false;
    },

    /**
     * updateChrome:
     * @doVisibility (boolean): (optional) whether to recalculate visibility.
     *
     * Updates input region and struts for all chrome actors. If @doVisibility is true,
     * then the visibility state of all chrome actors is recalculated first.
     *
     * Use with care as this is already frequently updated, and can reduce performance
     * if called unnecessarily.
     */
    updateChrome: function(doVisibility) {
        if (doVisibility === true)
            this._chrome._updateVisibility();
        else
            this._chrome._queueUpdateRegions();
    },

    /**
     * addChrome:
     * @actor (Clutter.Actor): an actor to add to the chrome
     * @params (object): (optional) additional params
     *      - visibleInFullcreen (boolean): The actor should be hidden when a window on the same monitor is fullscreen. Default %false.
     *      - affectsStruts (boolean): The actor's allocation should be used to add window manager struts. Default %false.
     *      - affectsInputRegion (boolean): The actor should be added to the stage input region. Default %true.
     *      - addToWindowgroup (boolean): The actor should be added as a top-level window. Default %false.
     *      - doNotAdd (boolean): The actor should not be added to the uiGroup. This has no effect if %addToWindowgroup is %true. Default %false.
     *
     * Adds @actor to the chrome, and (unless %affectsInputRegion in
     * @params is %false) extends the input region to include it.
     * Changes in @actor's size, position, and visibility will
     * automatically result in appropriate changes to the input
     * region.
     *
     * If %affectsStruts in @params is %true (and @actor is along a
     * screen edge), then @actor's size and position will also affect
     * the window manager struts. Changes to @actor's visibility will
     * NOT affect whether or not the strut is present, however.
     *
     * If %visibleInFullscreen in @params is %true, the actor will be
     * visible even when a fullscreen window should be covering it.
     */
    addChrome: function(actor, params) {
        this._chrome.addActor(actor, params);
    },

    /**
     * trackChrome:
     * @actor (Clutter.Actor): a descendant of the chrome to begin tracking
     * @params (object): (optional) additional params - defaults to same as chrome ancestor
     *      - visibleInFullcreen (boolean): The actor should be hidden when a window on the same monitor is fullscreen.
     *      - affectsStruts (boolean): The actor's allocation should be used to add window manager struts.
     *      - affectsInputRegion (boolean): The actor should be added to the stage input region.
     *      - addToWindowgroup (boolean): The actor should be added as a top-level window.
     *      - doNotAdd (boolean): The actor should not be added to the uiGroup. This has no effect if %addToWindowgroup is %true.
     *
     * Tells the chrome to track @actor, which must be a descendant
     * of an actor added via addChrome(). This can be used to extend the
     * struts or input region to cover specific children.
     *
     * @params can have any of the same values as in addChrome(),
     * though some possibilities don't make sense (eg, trying to have
     * a %visibleInFullscreen child of a non-%visibleInFullscreen
     * parent).
     */
    trackChrome: function(actor, params) {
        this._chrome.trackActor(actor, params);
    },

    /**
     * untrackChrome:
     * @actor (Clutter.Actor): an actor previously tracked via trackChrome()
     *
     * Undoes the effect of trackChrome()
     */
    untrackChrome: function(actor) {
        this._chrome.untrackActor(actor);
    },

    /**
     * removeChrome:
     * @actor (Clutter.Actor): a chrome actor
     *
     * Removes the actor from the chrome
     */
    removeChrome: function(actor) {
        this._chrome.removeActor(actor);
    },

    /**
     * findMonitorForActor:
     * @actor (Clutter.Actor): the actor to locate
     *
     * Finds the monitor the actor is currently located on.
     * If the actor is not found the primary monitor is returned.
     *
     * Returns (Layout.Monitor): the monitor
     */
    findMonitorForActor: function(actor) {
        return this._chrome.findMonitorForActor(actor);
    },

    /**
     * findMonitorIndexForActor
     * @actor (Clutter.Actor): the actor to locate
     *
     * Finds the index of the monitor the actor is currently
     * located on. If the actor is not found the primary monitor
     * index is returned.
     *
     * Returns (number): the monitor index
     */
    findMonitorIndexForActor: function(actor) {
        return this._chrome.findMonitorIndexForActor(actor);
    },

    /**
     * isTrackingChrome:
     * @actor (Clutter.Actor): the actor to check
     *
     * Determines whether the actor is currently tracked or not.
     *
     * Returns (boolean): whether the actor is currently tracked
     */
    isTrackingChrome: function(actor) {
        return this._chrome._findActor(actor) != -1;
    }
};
Signals.addSignalMethods(LayoutManager.prototype);



// This manages Cinnamon "chrome"; the UI that's visible in the
// normal mode (ie, outside the Overview), that surrounds the main
// workspace content.
const defaultParams = {
    visibleInFullscreen: false,
    affectsStruts: false,
    affectsInputRegion: true,
    addToWindowgroup: false,
    doNotAdd: false
};

function Chrome() {
    this._init.apply(this, arguments);
}

Chrome.prototype = {
    _init: function(layoutManager) {
        this._layoutManager = layoutManager;

        this._monitors = [];
        this._inOverview = false;
        this._isPopupWindowVisible = false;
        this._primaryMonitor = null;
        this._primaryIndex = -1;
        this._updateRegionIdle = 0;
        this._freezeUpdateCount = 0;
        this._trackedActors = [];
        this.rects = [];
        this.struts = [];

        this._layoutManager.connect('monitors-changed', () => this._relayout());
        global.display.connect('notify::focus-window', () => {
            Mainloop.idle_add_full(1000, () => this._windowsRestacked());
        });
        global.screen.connect('in-fullscreen-changed', () => this._updateVisibility(true));
        global.window_manager.connect('switch-workspace', () => this.onWorkspaceChanged());

        // Need to update struts on new workspaces when they are added
        global.screen.connect('notify::n-workspaces', () => this.onWorkspaceChanged());

        this._relayout();
    },

    init: function() {
        Main.overview.connect('showing', () => this._overviewShowing());
        Main.overview.connect('hidden', () => this._overviewHidden());
    },

    addActor: function(actor, params) {
        let actorData = Params.parse(params, defaultParams);
        if (actorData.addToWindowgroup) global.window_group.add_actor(actor);
        else if (!actorData.doNotAdd) Main.uiGroup.add_actor(actor);
        this._trackActor(actor, params);
    },

    trackActor: function(actor, params) {
        let ancestor = actor.get_parent();
        let index = this._findActor(ancestor);
        while (ancestor && index == -1) {
            ancestor = ancestor.get_parent();
            index = this._findActor(ancestor);
        }
        if (!ancestor)
            throw new Error('actor is not a descendent of a chrome actor');

        let ancestorData = this._trackedActors[index];
        if (!params)
            params = {};
        // We can't use Params.parse here because we want to drop
        // the extra values like ancestorData.actor
        for (let prop in defaultParams) {
            if (!params.hasOwnProperty(prop))
                params[prop] = ancestorData[prop];
        }

        this._trackActor(actor, params);
    },

    untrackActor: function(actor) {
        this._untrackActor(actor);
    },

    removeActor: function(actor) {
        let i = this._findActor(actor);

        if (i == -1)
            return;
        let actorData = this._trackedActors[i];

        if (actorData.addToWindowgroup) global.window_group.remove_actor(actor);
        else Main.uiGroup.remove_actor(actor);
        this._untrackActor(actor);
    },

    _findActor: function(actor) {
        for (let i = 0, len = this._trackedActors.length; i < len; i++) {
            let actorData = this._trackedActors[i];
            if (actorData.actor == actor)
                return i;
        }
        return -1;
    },

    modifyActorParams: function(actor, params) {
        let index = this._findActor(actor);
        if (index == -1)
            throw new Error('could not find actor in chrome');
        for (var i in params){
            this._trackedActors[index][i] = params[i];
        }
        this._queueUpdateRegions();
    },

    _trackActor: function(actor, params) {
        if (this._findActor(actor) != -1)
            throw new Error('trying to re-track existing chrome actor');

        let actorData = Params.parse(params, defaultParams);
        actorData.actor = actor;
        if (actorData.addToWindowgroup) actorData.isToplevel = actor.get_parent() == global.window_group;
        else actorData.isToplevel = actor.get_parent() == Main.uiGroup;
        actorData.visibleId = actor.connect('notify::visible', () => this._queueUpdateRegions());
        actorData.allocationId = actor.connect('notify::allocation', () => this._queueUpdateRegions());
        actorData.parentSetId = actor.connect('parent-set', (a) => this._actorReparented(a));
        // Note that destroying actor will unset its parent, so we don't
        // need to connect to 'destroy' too.

        this._trackedActors.push(actorData);
        this._queueUpdateRegions();
    },

    _untrackActor: function(actor) {
        let i = this._findActor(actor);

        if (i == -1)
            return;
        let actorData = this._trackedActors[i];

        this._trackedActors.splice(i, 1);
        actor.disconnect(actorData.visibleId);
        actor.disconnect(actorData.allocationId);
        actor.disconnect(actorData.parentSetId);

        this._queueUpdateRegions(true);
    },

    _actorReparented: function(actor) {
        let i = this._findActor(actor);
        if (i == -1)
            return;
        let actorData = this._trackedActors[i];

        let newParent = actor.get_parent();
        if (!newParent)
            this._untrackActor(actor);
        else{
            if (actorData.addToWindowgroup) actorData.isToplevel = (newParent == global.window_group);
            else actorData.isToplevel = (newParent == Main.uiGroup);
        }
    },

    _updateVisibility: function(updateNeeded = false) {
        for (let i = 0, len = this._trackedActors.length; i < len; i++) {
            let actorData = this._trackedActors[i], visible;
            if (!actorData.isToplevel)
                continue;
            else if (global.stage_input_mode == Cinnamon.StageInputMode.FULLSCREEN) {
                let monitor = this.findMonitorForActor(actorData.actor);

                if (global.screen.get_n_monitors() == 1 || !monitor.inFullscreen) {
                    visible = true;
                } else {
                    if (Main.modalActorFocusStack.length > 0) {
                        let modalActor = Main.modalActorFocusStack[Main.modalActorFocusStack.length - 1].actor;

                        if (this.findMonitorForActor(modalActor) == monitor) {
                            visible = true;
                        }
                    }
                }
            } else if (this._inOverview)
                visible = true;
            else if (!actorData.visibleInFullscreen &&
                     this.findMonitorForActor(actorData.actor).inFullscreen)
                visible = false;
            else
                visible = true;
            Main.uiGroup.set_skip_paint(actorData.actor, !visible);
        }
        this._queueUpdateRegions(updateNeeded);
    },

    _overviewShowing: function() {
        this._inOverview = true;
        this._updateVisibility();
    },

    _overviewHidden: function() {
        this._inOverview = false;
        this._updateVisibility();
    },

    _relayout: function() {
        this._monitors = this._layoutManager.monitors;
        this._primaryMonitor = this._layoutManager.primaryMonitor;
        this._primaryIndex = this._layoutManager.primaryIndex
        this._updateVisibility();
    },

    _findMonitorForRect: function(x, y, w, h) {
        // First look at what monitor the center of the rectangle is at
        let cx = x + w/2;
        let cy = y + h/2;
        let len = this._monitors.length;

        for (let i = 0; i < len; i++) {
            let monitor = this._monitors[i];
            if (cx >= monitor.x && cx < monitor.x + monitor.width &&
                cy >= monitor.y && cy < monitor.y + monitor.height)
                return [i, monitor];
        }
        // If the center is not on a monitor, return the first overlapping monitor
        for (let i = 0; i < len; i++) {
            let monitor = this._monitors[i];
            if (x + w > monitor.x && x < monitor.x + monitor.width &&
                y + h > monitor.y && y < monitor.y + monitor.height)
                return [i, monitor];
        }
        // otherwise on no monitor
        return [0, null];
    },

    _findMonitorForWindow: function(window) {
        return this._findMonitorForRect(window.x, window.y, window.width, window.height);
    },

    getMonitorInfoForActor: function(actor) {
        // special case for hideable panel actors:
        // due to position and clip they may appear originate on an adjacent monitor
        if (actor.maybeGet("_delegate") instanceof Panel.Panel
            && actor._delegate.isHideable())
            return [actor._delegate.monitorIndex, this._monitors[actor._delegate.monitorIndex]];

        let [x, y] = actor.get_transformed_position();
        let [w, h] = actor.get_transformed_size();
        let [index, monitor] = this._findMonitorForRect(x, y, w, h);
        return [index, monitor];
    },

    // This call guarantees that we return some monitor to simplify usage of it
    // In practice all tracked actors should be visible on some monitor anyway
    findMonitorForActor: function(actor) {
        let [index, monitor] = this.getMonitorInfoForActor(actor);
        if (monitor)
            return monitor;
        return this._primaryMonitor; // Not on any monitor, pretend its on the primary
    },

    findMonitorIndexForActor: function(actor) {
        let [index, monitor] = this.getMonitorInfoForActor(actor);
        if (monitor)
            return index;
        return this._primaryIndex; // Not on any monitor, pretend its on the primary
    },

    _queueUpdateRegions: function(updateNeeded = false) {
        if (!this._updateRegionIdle && !this._freezeUpdateCount)
            this._updateRegionIdle = Mainloop.idle_add(() => this.updateRegions(updateNeeded), Meta.PRIORITY_BEFORE_REDRAW);
    },

    freezeUpdateRegions: function() {
        if (this._updateRegionIdle)
            this.updateRegions();
        this._freezeUpdateCount++;
    },

    thawUpdateRegions: function() {
        this._freezeUpdateCount = --this._freezeUpdateCount >= 0 ? this._freezeUpdateCount : 0;
        this._queueUpdateRegions();
    },

    _windowsRestacked: function() {
        const {_isPopupWindowVisible} = this;

        this._isPopupWindowVisible = global.display.popup_window_visible();

        if (_isPopupWindowVisible != this._isPopupWindowVisible) {
            this._updateVisibility();

            /* Pointer only needs to be updated to account for tray icon popup windows, which
               will be reflected by the global.display.popup_window_visible return value. */
            Mainloop.idle_add_full(1000, () => global.sync_pointer());
        } else {
            this._queueUpdateRegions();
        }
    },

    /* Avoid calling into C code unless we absolutely have to, including their
       constructors - this improves CPU usage. updateRegions gets called too
       much, and the net effect is more time spent context switching.*/
    updateRects: function() {
        global.set_stage_input_region(
            map(this.rects, function(rect) {
                return new Meta.Rectangle(rect);
            })
        );
    },

    updateStruts: function() {
        global.screen.get_active_workspace().set_builtin_struts(
            map(this.struts, function(strut) {
                return new Meta.Strut({
                    rect: new Meta.Rectangle(strut.rect),
                    side: strut.side
                })
            })
        );
    },

    onWorkspaceChanged: function() {
        if (this.rects.length) this.updateRects();
        if (this.struts.length) this.updateStruts();
    },

    updateRegions: function(updateNeeded = false) {
        let trackedActorsLength = this._trackedActors.length;
        let rects = [];
        let struts = [];
        let rectsChanged = false;
        let strutsChanged = false;
        let wantsInputRegion = !this._isPopupWindowVisible;
        let i = 0;

        if (this._updateRegionIdle) {
            Mainloop.source_remove(this._updateRegionIdle);
            this._updateRegionIdle = 0;
        }

        if (updateNeeded) {
            rectsChanged = strutsChanged = true;
        }

        for (; i < trackedActorsLength; i++) {
            let actorData = this._trackedActors[i];
            if (!(actorData.affectsInputRegion && wantsInputRegion) && !actorData.affectsStruts)
                continue;

            let [x, y] = actorData.actor.get_transformed_position();
            let [w, h] = actorData.actor.get_transformed_size();

            if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) {
                // If the actor isn't giving us a valid size/position, skip it
                // It would make the loop fail with an exception and affect the
                // other actors
                continue;
            }

            x = Math.round(x);
            y = Math.round(y);
            w = Math.round(w);
            h = Math.round(h);

            if (wantsInputRegion
                && actorData.affectsInputRegion
                && actorData.actor.get_paint_visibility()
                && !Main.uiGroup.get_skip_paint(actorData.actor)) {

                let rect = {x, y, width: w, height: h};

                // special case for hideable panel actors:
                // clip any off-monitor input region
                if (actorData.actor.maybeGet("_delegate") instanceof Panel.Panel
                    && actorData.actor._delegate.isHideable()) {
                    let m = this._monitors[actorData.actor._delegate.monitorIndex];
                    if (m) rect = intersect(rect, m);
                }

                let refRect = findIndex(this.rects, function(r) {
                    return (
                        r.x === rect.x &&
                        r.y === rect.y &&
                        r.width === rect.width &&
                        r.height === rect.height
                    );
                });

                /* Check if the rect exists, if so, set the parent scope's changed variable. */
                if (refRect === -1) {
                    rectsChanged = true;
                }

                rects.push(rect);
            }

            if (actorData.affectsStruts) {
                // Limit struts to the size of the screen
                let x1 = Math.max(x, 0);
                let x2 = Math.min(x + w, global.screen_width);
                let y1 = Math.max(y, 0);
                let y2 = Math.min(y + h, global.screen_height);

                // Metacity wants to know what side of the monitor the
                // strut is considered to be attached to. First, we find
                // the monitor that contains the strut. If the actor is
                // only touching one edge, or is touching the entire
                // border of that monitor, then it's obvious which side
                // to call it. If it's in a corner, we pick a side
                // arbitrarily. If it doesn't touch any edges, or it
                // spans the width/height across the middle of the
                // screen, then we don't create a strut for it at all.

                let monitor = this.findMonitorForActor(actorData.actor);
                let side;
                if (x1 <= monitor.x && x2 >= monitor.x + monitor.width) {
                    if (y1 <= monitor.y)
                        side = Meta.Side.TOP;
                    else if (y2 >= monitor.y + monitor.height)
                        side = Meta.Side.BOTTOM;
                    else
                        continue;
                } else if (y1 <= monitor.y && y2 >= monitor.y + monitor.height) {
                    if (x1 <= monitor.x)
                        side = Meta.Side.LEFT;
                    else if (x2 >= monitor.x + monitor.width)
                        side = Meta.Side.RIGHT;
                    else
                        continue;
                } else if (x1 <= monitor.x)
                    side = Meta.Side.LEFT;
                else if (y1 <= monitor.y)
                    side = Meta.Side.TOP;
                else if (x2 >= monitor.x + monitor.width)
                    side = Meta.Side.RIGHT;
                else if (y2 >= monitor.y + monitor.height)
                    side = Meta.Side.BOTTOM;
                else
                    continue;

                let rect = {
                    x: x1,
                    y: y1,
                    width: x2 - x1,
                    height: y2 - y1
                };

                /* Check if the strut exists, if so, set the parent scope's changed variable. */
                let refStrut = findIndex(this.struts, function(strut) {
                    return (
                        rect.x === strut.rect.x &&
                        rect.y === strut.rect.y &&
                        rect.width === strut.rect.width &&
                        rect.height === strut.rect.height &&
                        strut.side === side
                    )
                });

                if (refStrut === -1) {
                    strutsChanged = true;
                }

                struts.push({rect, side});
            }
        }

        /* Cache the rects and struts for the next comparison. */
        this.rects = rects;
        this.struts = struts;

        if (rectsChanged) this.updateRects();
        if (strutsChanged) this.updateStruts();

        return false;
    }
};
