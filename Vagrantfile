
if ENV['AWS_ACCESS_KEY_ID'] == nil or ENV['AWS_SECRET_ACCESS_KEY'] == nil
  raise Vagrant::Errors::VagrantError.new,
        "This vagrantfile requires AWS credentials as environment variables!\n"
end

Vagrant.configure("2") do |config|
  config.vm.box = "taskcluster-dev-0.0.0"
  config.vm.box_url = "https://s3.amazonaws.com/task-cluster-dev/0.0.0/taskcluster_dev.box"
  config.vm.provision "shell", inline: <<-SCRIPT
echo 'export AWS_ACCESS_KEY_ID="#{ENV['AWS_ACCESS_KEY_ID']}";' >> /home/vagrant/.bashrc;
echo 'export AWS_SECRET_ACCESS_KEY="#{ENV['AWS_SECRET_ACCESS_KEY']}";' >> /home/vagrant/.bashrc;
SCRIPT
end
