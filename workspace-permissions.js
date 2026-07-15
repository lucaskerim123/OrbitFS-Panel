import { query } from './db.js';

export const WORKSPACE_ACTIONS=['read','write','download','move','delete','create'];
export const WORKSPACE_ROLES=['editor','contributor','viewer'];
export const WORKSPACE_ADMIN_ACTIONS=['view_settings','edit_settings','manage_members','manage_permissions','delete_workspace'];
const FULL={read:true,write:true,download:true,move:true,delete:true,create:true};
const READ={read:true,write:false,download:true,move:false,delete:false,create:false};
const ADMIN_FULL={view_settings:true,edit_settings:true,manage_members:true,manage_permissions:true,delete_workspace:true};
const ADMIN_DEFAULTS={
  editor:{view_settings:true,edit_settings:false,manage_members:false,manage_permissions:false,delete_workspace:false},
  contributor:{view_settings:false,edit_settings:false,manage_members:false,manage_permissions:false,delete_workspace:false},
  viewer:{view_settings:false,edit_settings:false,manage_members:false,manage_permissions:false,delete_workspace:false},
};

export function roleDefaults(role){
  if(role==='editor') return {...FULL};
  if(role==='contributor') return {...FULL,delete:false};
  return {...READ};
}

export function workspaceAdminRoleDefaults(role){
  return {...(ADMIN_DEFAULTS[role]||ADMIN_DEFAULTS.viewer)};
}

export function fullWorkspaceAdminPermissions(){ return {...ADMIN_FULL}; }

export function normalizeWorkspacePath(value=''){
  return String(value).replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');
}
export async function effectiveWorkspacePermissions(workspaceId,role,filepath=''){
  const base=roleDefaults(role);
  if(!WORKSPACE_ROLES.includes(role)) return base;
  const target=normalizeWorkspacePath(filepath);
  const row=(await query(`SELECT can_read,can_write,can_download,can_move,can_delete,can_create
    FROM workspace_permission_overrides
    WHERE workspace_id=$1 AND workspace_role=$2
      AND ($3=relative_path OR $3 LIKE relative_path || '/%' OR relative_path='')
    ORDER BY length(relative_path) DESC LIMIT 1`,[workspaceId,role,target])).rows[0];
  return row?{read:row.can_read,write:row.can_write,download:row.can_download,move:row.can_move,delete:row.can_delete,create:row.can_create}:base;
}

export async function effectiveWorkspaceAdminPermissions(workspaceId,role){
  const base=workspaceAdminRoleDefaults(role);
  if(!WORKSPACE_ROLES.includes(role)) return base;
  const row=(await query(`SELECT can_view_settings,can_edit_settings,can_manage_members,can_manage_permissions,can_delete_workspace
    FROM workspace_role_admin_permissions WHERE workspace_id=$1 AND workspace_role=$2 LIMIT 1`,[workspaceId,role])).rows[0];
  return row?{
    view_settings:row.can_view_settings,
    edit_settings:row.can_edit_settings,
    manage_members:row.can_manage_members,
    manage_permissions:row.can_manage_permissions,
    delete_workspace:row.can_delete_workspace,
  }:base;
}
