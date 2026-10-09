#include <gio/gio.h>
#include <glib-unix.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static GMainLoop *loop;
static GDBusConnection *bus;
static gboolean autostart = FALSE;
static char status_text[512] = "Echo is starting";
static guint revision = 1;
static const char *sni =
"<node><interface name='org.kde.StatusNotifierItem'>"
"<property name='Category' type='s' access='read'/><property name='Id' type='s' access='read'/>"
"<property name='Title' type='s' access='read'/><property name='Status' type='s' access='read'/>"
"<property name='IconName' type='s' access='read'/><property name='Menu' type='o' access='read'/>"
"<property name='ItemIsMenu' type='b' access='read'/>"
"<method name='Activate'><arg type='i' direction='in'/><arg type='i' direction='in'/></method>"
"<method name='SecondaryActivate'><arg type='i' direction='in'/><arg type='i' direction='in'/></method>"
"<method name='ContextMenu'><arg type='i' direction='in'/><arg type='i' direction='in'/></method>"
"<method name='Scroll'><arg type='i' direction='in'/><arg type='s' direction='in'/></method>"
"<signal name='NewTitle'/></interface></node>";
static const char *menu =
"<node><interface name='com.canonical.dbusmenu'>"
"<property name='Version' type='u' access='read'/><property name='TextDirection' type='s' access='read'/>"
"<property name='Status' type='s' access='read'/><property name='IconThemePath' type='as' access='read'/>"
"<method name='GetLayout'><arg type='i' direction='in'/><arg type='i' direction='in'/><arg type='as' direction='in'/><arg type='u' direction='out'/><arg type='(ia{sv}av)' direction='out'/></method>"
"<method name='GetGroupProperties'><arg type='ai' direction='in'/><arg type='as' direction='in'/><arg type='a(ia{sv})' direction='out'/></method>"
"<method name='GetProperty'><arg type='i' direction='in'/><arg type='s' direction='in'/><arg type='v' direction='out'/></method>"
"<method name='Event'><arg type='i' direction='in'/><arg type='s' direction='in'/><arg type='v' direction='in'/><arg type='u' direction='in'/></method>"
"<method name='EventGroup'><arg type='a(isvu)' direction='in'/><arg type='ai' direction='out'/></method>"
"<method name='AboutToShow'><arg type='i' direction='in'/><arg type='b' direction='out'/></method>"
"<method name='AboutToShowGroup'><arg type='ai' direction='in'/><arg type='ai' direction='out'/><arg type='ai' direction='out'/></method>"
"<signal name='LayoutUpdated'><arg type='u'/><arg type='i'/></signal></interface></node>";
static GVariant *properties(int id) {
  GVariantBuilder b; g_variant_builder_init(&b,G_VARIANT_TYPE("a{sv}"));
  const char *labels[] = {"Echo",status_text,"Open Echo / Retry","Start at login","Quit Echo"};
  if(id < 0 || id > 4) id = 0;
  g_variant_builder_add(&b,"{sv}","label",g_variant_new_string(labels[id]));
  g_variant_builder_add(&b,"{sv}","enabled",g_variant_new_boolean(id != 1));
  g_variant_builder_add(&b,"{sv}","visible",g_variant_new_boolean(TRUE));
  if(id == 0) g_variant_builder_add(&b,"{sv}","children-display",g_variant_new_string("submenu"));
  if(id == 3) {
    g_variant_builder_add(&b,"{sv}","toggle-type",g_variant_new_string("checkmark"));
    g_variant_builder_add(&b,"{sv}","toggle-state",g_variant_new_int32(autostart ? 1 : 0));
  }
  return g_variant_builder_end(&b);
}
static GVariant *layout(int id) {
  GVariantBuilder b; g_variant_builder_init(&b,G_VARIANT_TYPE("av"));
  if(id == 0) for(int child=1;child<=4;child++) g_variant_builder_add(&b,"v",layout(child));
  return g_variant_new("(i@a{sv}@av)",id,properties(id),g_variant_builder_end(&b));
}
static void action(int id, const char *event) {
  if(strcmp(event,"clicked")) return;
  if(id == 2) puts("open"); else if(id == 3) puts("autostart"); else if(id == 4) puts("quit");
  fflush(stdout);
}
static void method(GDBusConnection *c,const char *sender,const char *path,const char *iface,const char *name,GVariant *args,GDBusMethodInvocation *call,gpointer data) {
  (void)c;(void)sender;(void)path;(void)data;
  if(!strcmp(iface,"org.kde.StatusNotifierItem")) {
    if(!strcmp(name,"Activate") || !strcmp(name,"SecondaryActivate")) action(2,"clicked");
    g_dbus_method_invocation_return_value(call,NULL);return;
  }
  if(!strcmp(name,"GetLayout")) {
    int id;g_variant_get_child(args,0,"i",&id);
    if(id < 0 || id > 4) { g_dbus_method_invocation_return_dbus_error(call,"com.canonical.dbusmenu.Error","Unknown item");return; }
    g_dbus_method_invocation_return_value(call,g_variant_new("(u@(ia{sv}av))",revision,layout(id)));
  } else if(!strcmp(name,"GetGroupProperties")) {
    GVariant *ids=g_variant_get_child_value(args,0);GVariantIter iter;g_variant_iter_init(&iter,ids);
    GVariantBuilder b;g_variant_builder_init(&b,G_VARIANT_TYPE("a(ia{sv})"));int id;
    if(!g_variant_n_children(ids)) for(id=0;id<=4;id++) g_variant_builder_add(&b,"(i@a{sv})",id,properties(id));
    else while(g_variant_iter_next(&iter,"i",&id)) if(id>=0 && id<=4) g_variant_builder_add(&b,"(i@a{sv})",id,properties(id));
    g_variant_unref(ids);g_dbus_method_invocation_return_value(call,g_variant_new("(@a(ia{sv}))",g_variant_builder_end(&b)));
  } else if(!strcmp(name,"GetProperty")) {
    int id;const char *key;g_variant_get(args,"(i&s)",&id,&key);
    GVariant *props=g_variant_ref_sink(properties(id)),*v=g_variant_lookup_value(props,key,NULL);
    if(v) { g_dbus_method_invocation_return_value(call,g_variant_new("(v)",v));g_variant_unref(v); }
    else g_dbus_method_invocation_return_dbus_error(call,"com.canonical.dbusmenu.Error","Unknown property");
    g_variant_unref(props);
  } else if(!strcmp(name,"Event")) {
    int id;const char *event;g_variant_get_child(args,0,"i",&id);g_variant_get_child(args,1,"&s",&event);action(id,event);
    g_dbus_method_invocation_return_value(call,NULL);
  } else if(!strcmp(name,"EventGroup")) {
    GVariant *events=g_variant_get_child_value(args,0);GVariantIter iter;g_variant_iter_init(&iter,events);GVariant *event;
    while((event=g_variant_iter_next_value(&iter))) { int id;const char *name;g_variant_get_child(event,0,"i",&id);g_variant_get_child(event,1,"&s",&name);action(id,name);g_variant_unref(event); }
    g_variant_unref(events);g_dbus_method_invocation_return_value(call,g_variant_new("(@ai)",g_variant_new_array(G_VARIANT_TYPE_INT32,NULL,0)));
  } else if(!strcmp(name,"AboutToShow")) g_dbus_method_invocation_return_value(call,g_variant_new("(b)",FALSE));
  else if(!strcmp(name,"AboutToShowGroup")) g_dbus_method_invocation_return_value(call,g_variant_new("(@ai@ai)",g_variant_new_array(G_VARIANT_TYPE_INT32,NULL,0),g_variant_new_array(G_VARIANT_TYPE_INT32,NULL,0)));
  else g_dbus_method_invocation_return_dbus_error(call,"com.canonical.dbusmenu.Error","Unsupported method");
}
static GVariant *property(GDBusConnection *c,const char *sender,const char *path,const char *iface,const char *name,GError **error,gpointer data) {
  (void)c;(void)sender;(void)path;(void)error;(void)data;
  if(!strcmp(iface,"com.canonical.dbusmenu")) {
    if(!strcmp(name,"Version")) return g_variant_new_uint32(3);
    if(!strcmp(name,"IconThemePath")) return g_variant_new_strv(NULL,0);
    return g_variant_new_string(!strcmp(name,"TextDirection") ? "ltr" : "normal");
  }
  if(!strcmp(name,"Menu")) return g_variant_new_object_path("/Menu");
  if(!strcmp(name,"ItemIsMenu")) return g_variant_new_boolean(TRUE);
  return g_variant_new_string(!strcmp(name,"Category") ? "ApplicationStatus" : !strcmp(name,"Id") ? "echo" : !strcmp(name,"Title") ? status_text : !strcmp(name,"Status") ? "Active" : "mail-message-new");
}
static gboolean input(GIOChannel *channel,GIOCondition condition,gpointer data) {
  (void)data;
  if(condition & (G_IO_HUP|G_IO_ERR)) { g_main_loop_quit(loop);return FALSE; }
  char *line=NULL;gsize size;
  if(g_io_channel_read_line(channel,&line,&size,NULL,NULL) != G_IO_STATUS_NORMAL) { g_free(line);return TRUE; }
  if(size > 500) { g_free(line);g_main_loop_quit(loop);return FALSE; }
  g_strchomp(line);
  if(!strcmp(line,"exit")) g_main_loop_quit(loop);
  else if(g_str_has_prefix(line,"status ")) g_strlcpy(status_text,line+7,sizeof(status_text));
  else if(g_str_has_prefix(line,"autostart ")) autostart=!strcmp(line+10,"1");
  g_free(line);revision++;
  g_dbus_connection_emit_signal(bus,NULL,"/Menu","com.canonical.dbusmenu","LayoutUpdated",g_variant_new("(ui)",revision,0),NULL);
  g_dbus_connection_emit_signal(bus,NULL,"/StatusNotifierItem","org.kde.StatusNotifierItem","NewTitle",NULL,NULL);
  return TRUE;
}
int main(int argc,char **argv) {
  if(argc==2 && !strcmp(argv[1],"--probe")) return 0;
  GError *error=NULL;bus=g_bus_get_sync(G_BUS_TYPE_SESSION,NULL,&error);if(!bus) return 2;
  GDBusNodeInfo *a=g_dbus_node_info_new_for_xml(sni,&error),*b=g_dbus_node_info_new_for_xml(menu,&error);if(!a||!b) return 2;
  GDBusInterfaceVTable v={.method_call=method,.get_property=property};
  if(!g_dbus_connection_register_object(bus,"/StatusNotifierItem",a->interfaces[0],&v,NULL,NULL,&error) ||
     !g_dbus_connection_register_object(bus,"/Menu",b->interfaces[0],&v,NULL,NULL,&error)) return 2;
  GVariant *reply=g_dbus_connection_call_sync(bus,"org.kde.StatusNotifierWatcher","/StatusNotifierWatcher","org.kde.StatusNotifierWatcher","RegisterStatusNotifierItem",
    g_variant_new("(s)",g_dbus_connection_get_unique_name(bus)),NULL,G_DBUS_CALL_FLAGS_NONE,3000,NULL,&error);
  if(!reply) return 2;
  g_variant_unref(reply);
  loop=g_main_loop_new(NULL,FALSE);
  GIOChannel *channel=g_io_channel_unix_new(STDIN_FILENO);g_io_channel_set_flags(channel,G_IO_FLAG_NONBLOCK,NULL);
  g_io_add_watch(channel,G_IO_IN|G_IO_HUP|G_IO_ERR,input,NULL);
  puts("ready");fflush(stdout);g_main_loop_run(loop);
  g_io_channel_unref(channel);g_main_loop_unref(loop);g_dbus_node_info_unref(a);g_dbus_node_info_unref(b);g_object_unref(bus);return 0;
}
