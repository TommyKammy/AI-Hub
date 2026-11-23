export default {
  async scheduled(_controller,env) {
    const destination=new URL(env.HUB_ORIGIN);
    if (destination.protocol!=="http:" || destination.hostname!=="127.0.0.1" || !destination.port ||
        destination.username || destination.password || !/^[a-zA-Z0-9_-]{32,128}$/.test(env.CRON_TOKEN ?? ""))
      throw Error("ローカルの予約起動設定を確認してください。");
    const response=await fetch(new URL("/internal/local-scheduler/tick",destination),{
      method:"POST",headers:{Authorization:"Bearer "+env.CRON_TOKEN},
    });
    if (!response.ok) throw Error("ローカルの予約起動に失敗しました。HTTP "+response.status);
    const {created,disabled}=await response.json();
    console.log(JSON.stringify({event:"local-scheduler-tick",created,disabled}));
  },
};
