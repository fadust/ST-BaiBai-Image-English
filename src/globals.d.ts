declare global {
  // ST mounts these dependencies globally; only the minimal types the plugin actually uses are declared here.
  const $: any;
  const _: any;
  const toastr: any;
  const __BBI_VERSION__: string;
}

export {};
