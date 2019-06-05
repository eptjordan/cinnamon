const Mainloop = imports.mainloop;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Util = imports.misc.util;

function perform_search(pattern){
    push_results(pattern);
}

function push_results(results){
    var file = Gio.file_new_for_path('/home/tjordan/.local/share/cinnamon/search_providers/google@eptjordan/icon.png');
    var gicon = new Gio.FileIcon({ file: file });
    var myicon = new St.Icon({gicon: gicon, icon_size: 32, icon_type: St.IconType.FULLCOLOR, reactive: true, track_hover: true, style_class: 'applet-icon'});
    var pattern = results.replace(" ", "+");
    var results_array = new Array();
    results_array.push({
        id: pattern,
        label: _("Search Google for '" + results + "'"),
        icon: myicon
    });
    send_results(results_array);
}

function on_result_selected(result){
    Util.spawn(['xdg-open', "https://www.google.com/search?q=%s".replace("%s", result.id)]);
}
