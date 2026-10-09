/*
 * The POCO X3 NFC page in Mobile Settings. "Launcher" picks the home screen the home gesture opens: Phosh's own
 * app grid or Neo (de.yesman.neo "launcher", read by the patched Phosh, phosh 0.58.0-1+neo1). "Screen lock" picks
 * Swipe (Phosh's require-unlock off), Pattern (de.yesman.neo lock-type, the pattern is the password, set in
 * ms-plugin-surya-pattern.c) or PIN (Phosh's keypad).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

#define G_LOG_DOMAIN "ms-plugin-surya-panel"

#include "ms-plugin-surya-panel.h"
#include "ms-plugin-surya-pattern.h"

#include <adwaita.h>

#define NEO_SCHEMA "de.yesman.neo"

static const char * const launchers[] = { "phosh", "neo", NULL };
static const char * const lock_types[] = { "swipe", "pattern", "pin", NULL };

struct _MsPluginSuryaPanel {
  MsPluginPanel  parent;

  GSettings     *neo_settings;
  GSettings     *lock_settings;
  AdwComboRow   *launcher_row;
  AdwComboRow   *lock_row;
  GtkWidget     *pattern_row;
  gboolean       syncing;
};

G_DEFINE_TYPE (MsPluginSuryaPanel, ms_plugin_surya_panel, MS_TYPE_PLUGIN_PANEL)


static void
sync_from_settings (MsPluginSuryaPanel *self)
{
  g_autofree char *launcher = g_settings_get_string (self->neo_settings, "launcher");

  self->syncing = TRUE;
  adw_combo_row_set_selected (self->launcher_row, g_strcmp0 (launcher, "neo") == 0 ? 1 : 0);
  self->syncing = FALSE;
}


static guint
lock_index (MsPluginSuryaPanel *self)
{
  g_autofree char *type = g_settings_get_string (self->neo_settings, "lock-type");

  /* Phosh's own switch wins: without require-unlock there is no password, whatever lock-type says */
  if (!g_settings_get_boolean (self->lock_settings, "require-unlock"))
    return 0;
  return g_strcmp0 (type, "pattern") == 0 ? 1 : 2;
}


static void
sync_lock (MsPluginSuryaPanel *self)
{
  self->syncing = TRUE;
  adw_combo_row_set_selected (self->lock_row, lock_index (self));
  self->syncing = FALSE;
}


static void
apply_lock (MsPluginSuryaPanel *self, guint i)
{
  g_settings_set_string (self->neo_settings, "lock-type", lock_types[i]);
  g_settings_set_boolean (self->lock_settings, "require-unlock", i != 0);
}


static void
on_pattern_done (gboolean ok, gpointer data)
{
  MsPluginSuryaPanel *self = MS_PLUGIN_SURYA_PANEL (data);

  if (ok)
    apply_lock (self, 1);
  else
    sync_lock (self);       /* cancelled: back to what it was */
  g_object_unref (self);
}


static void
on_lock_selected (MsPluginSuryaPanel *self)
{
  guint i = adw_combo_row_get_selected (self->lock_row);

  if (self->syncing || !self->neo_settings || i >= G_N_ELEMENTS (lock_types) - 1)
    return;
  if (i == 1) {
    /* a pattern takes effect only once it is drawn, confirmed and set as the password */
    ms_pattern_dialog_present (GTK_WIDGET (self), on_pattern_done, g_object_ref (self));
    return;
  }
  apply_lock (self, i);
}


/* "Change pattern" only with the pattern lock */
static void
update_pattern_row (MsPluginSuryaPanel *self)
{
  gtk_widget_set_visible (self->pattern_row, adw_combo_row_get_selected (self->lock_row) == 1);
}


static void
on_set_pattern (MsPluginSuryaPanel *self)
{
  ms_pattern_dialog_present (GTK_WIDGET (self), on_pattern_done, g_object_ref (self));
}


static void
on_launcher_selected (MsPluginSuryaPanel *self)
{
  guint i = adw_combo_row_get_selected (self->launcher_row);

  if (self->syncing || !self->neo_settings || i >= G_N_ELEMENTS (launchers) - 1)
    return;
  g_settings_set_string (self->neo_settings, "launcher", launchers[i]);
}


static void
ms_plugin_surya_panel_dispose (GObject *object)
{
  MsPluginSuryaPanel *self = MS_PLUGIN_SURYA_PANEL (object);

  g_clear_object (&self->neo_settings);
  g_clear_object (&self->lock_settings);

  G_OBJECT_CLASS (ms_plugin_surya_panel_parent_class)->dispose (object);
}


static void
ms_plugin_surya_panel_class_init (MsPluginSuryaPanelClass *klass)
{
  G_OBJECT_CLASS (klass)->dispose = ms_plugin_surya_panel_dispose;
}


static void
ms_plugin_surya_panel_init (MsPluginSuryaPanel *self)
{
  GSettingsSchemaSource *source = g_settings_schema_source_get_default ();
  g_autoptr (GSettingsSchema) schema = NULL;
  AdwPreferencesPage *page = ADW_PREFERENCES_PAGE (adw_preferences_page_new ());
  AdwPreferencesGroup *group = ADW_PREFERENCES_GROUP (adw_preferences_group_new ());
  GtkStringList *names = gtk_string_list_new ((const char * const []) { "Phosh", "Neo", NULL });

  adw_preferences_group_set_title (group, "Home Screen");
  self->launcher_row = ADW_COMBO_ROW (adw_combo_row_new ());
  adw_preferences_row_set_title (ADW_PREFERENCES_ROW (self->launcher_row), "Launcher");
  adw_combo_row_set_model (self->launcher_row, G_LIST_MODEL (names));
  g_object_unref (names);
  adw_preferences_group_add (group, GTK_WIDGET (self->launcher_row));
  adw_preferences_page_add (page, group);

  {
    AdwPreferencesGroup *lock_group = ADW_PREFERENCES_GROUP (adw_preferences_group_new ());
    GtkStringList *types = gtk_string_list_new ((const char * const []) { "Swipe", "Pattern", "PIN", NULL });
    GtkWidget *change = gtk_button_new_with_label ("Change");

    adw_preferences_group_set_title (lock_group, "Screen Lock");
    adw_preferences_group_set_description (lock_group,
      "Swipe unlocks without a password. Pattern and PIN unlock with your password: "
      "a pattern you set here becomes your password (also for sudo, SSH and the console).");
    self->lock_row = ADW_COMBO_ROW (adw_combo_row_new ());
    adw_preferences_row_set_title (ADW_PREFERENCES_ROW (self->lock_row), "Screen lock");
    adw_combo_row_set_model (self->lock_row, G_LIST_MODEL (types));
    g_object_unref (types);
    adw_preferences_group_add (lock_group, GTK_WIDGET (self->lock_row));
    self->pattern_row = adw_action_row_new ();
    adw_preferences_row_set_title (ADW_PREFERENCES_ROW (self->pattern_row), "Unlock pattern");
    gtk_widget_set_valign (change, GTK_ALIGN_CENTER);
    adw_action_row_add_suffix (ADW_ACTION_ROW (self->pattern_row), change);
    g_signal_connect_swapped (change, "clicked", G_CALLBACK (on_set_pattern), self);
    adw_preferences_group_add (lock_group, self->pattern_row);
    adw_preferences_page_add (page, lock_group);
  }
  adw_bin_set_child (ADW_BIN (self), GTK_WIDGET (page));

  schema = source ? g_settings_schema_source_lookup (source, NEO_SCHEMA, TRUE) : NULL;
  if (!schema) {
    /* without neo-launcher there is only Phosh's grid */
    adw_action_row_set_subtitle (ADW_ACTION_ROW (self->launcher_row), "Install neo-launcher to choose Neo");
    gtk_widget_set_sensitive (GTK_WIDGET (self->launcher_row), FALSE);
    gtk_widget_set_sensitive (GTK_WIDGET (self->lock_row), FALSE);
    gtk_widget_set_visible (self->pattern_row, FALSE);
    return;
  }

  adw_action_row_set_subtitle (ADW_ACTION_ROW (self->launcher_row), "What the home gesture opens");
  self->neo_settings = g_settings_new (NEO_SCHEMA);
  sync_from_settings (self);
  g_signal_connect_object (self->neo_settings, "changed::launcher",
                           G_CALLBACK (sync_from_settings), self, G_CONNECT_SWAPPED);
  g_signal_connect_object (self->launcher_row, "notify::selected",
                           G_CALLBACK (on_launcher_selected), self, G_CONNECT_SWAPPED);

  self->lock_settings = g_settings_new ("sm.puri.phosh.lockscreen");
  sync_lock (self);
  g_signal_connect_object (self->neo_settings, "changed::lock-type", G_CALLBACK (sync_lock), self, G_CONNECT_SWAPPED);
  g_signal_connect_object (self->lock_settings, "changed::require-unlock", G_CALLBACK (sync_lock), self,
                           G_CONNECT_SWAPPED);
  g_signal_connect_object (self->lock_row, "notify::selected", G_CALLBACK (on_lock_selected), self,
                           G_CONNECT_SWAPPED);
  g_signal_connect_object (self->lock_row, "notify::selected", G_CALLBACK (update_pattern_row), self,
                           G_CONNECT_SWAPPED);
  update_pattern_row (self);
}
